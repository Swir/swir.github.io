namespace Swir.Desktop.Host;

internal static class DesktopHostRestartHooksSelfTests
{
    private static async Task Main()
    {
        await PrepareAndResumeAreOrdered();
        await PrepareFailureUnlocksRetry();
        await DuplicatePrepareIsRejected();
        await ResumeFailureKeepsPreparedState();
        Console.WriteLine("Desktop host restart hooks self-tests passed.");
    }

    private static async Task PrepareAndResumeAreOrdered()
    {
        var events = new List<string>();
        var hooks = new DesktopHostRestartHooks(
            _ => { events.Add("suspend"); return Task.CompletedTask; },
            _ => { events.Add("resume"); return Task.CompletedTask; });

        await hooks.PrepareAsync(CancellationToken.None);
        Assert(hooks.IsPrepared, "Host should be prepared after suspend completes.");
        await hooks.ResumeAsync(CancellationToken.None);
        Assert(!hooks.IsPrepared, "Host should leave prepared state after resume completes.");
        Assert(events.SequenceEqual(new[] { "suspend", "resume" }), "Suspend/resume order changed.");
    }

    private static async Task PrepareFailureUnlocksRetry()
    {
        var attempts = 0;
        var hooks = new DesktopHostRestartHooks(
            _ =>
            {
                attempts++;
                if (attempts == 1) throw new InvalidOperationException("synthetic suspend failure");
                return Task.CompletedTask;
            },
            _ => Task.CompletedTask);

        await ExpectAsync<InvalidOperationException>(() => hooks.PrepareAsync(CancellationToken.None));
        Assert(!hooks.IsPrepared, "Failed prepare must not leave host latched.");
        await hooks.PrepareAsync(CancellationToken.None);
        Assert(hooks.IsPrepared && attempts == 2, "Prepare should be retryable after pre-handoff failure.");
    }

    private static async Task DuplicatePrepareIsRejected()
    {
        var hooks = new DesktopHostRestartHooks(_ => Task.CompletedTask, _ => Task.CompletedTask);
        await hooks.PrepareAsync(CancellationToken.None);
        var ex = await ExpectAsync<UpdateSecurityException>(() => hooks.PrepareAsync(CancellationToken.None));
        Assert(ex.Code == "UPDATE_HOST_ALREADY_PREPARED", "Duplicate prepare must have stable error code.");
    }

    private static async Task ResumeFailureKeepsPreparedState()
    {
        var resumeAttempts = 0;
        var hooks = new DesktopHostRestartHooks(
            _ => Task.CompletedTask,
            _ =>
            {
                resumeAttempts++;
                if (resumeAttempts == 1) throw new InvalidOperationException("synthetic resume failure");
                return Task.CompletedTask;
            });

        await hooks.PrepareAsync(CancellationToken.None);
        await ExpectAsync<InvalidOperationException>(() => hooks.ResumeAsync(CancellationToken.None));
        Assert(hooks.IsPrepared, "Failed resume must stay fail-closed instead of reopening bridge admission.");
        await hooks.ResumeAsync(CancellationToken.None);
        Assert(!hooks.IsPrepared && resumeAttempts == 2, "Resume should clear prepared state only after success.");
    }

    private static async Task<T> ExpectAsync<T>(Func<Task> action) where T : Exception
    {
        try { await action(); }
        catch (T ex) { return ex; }
        throw new InvalidOperationException($"Expected exception {typeof(T).Name}.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
