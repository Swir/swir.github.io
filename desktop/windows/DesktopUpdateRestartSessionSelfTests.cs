namespace Swir.Desktop.Host;

internal static class DesktopUpdateRestartSessionSelfTests
{
    public static async Task Main()
    {
        await GateRejectsNewWorkAndDrainsExistingAsync();
        await SessionOrdersDrainBeforePrepareAndExitAsync();
        await SessionResumesBridgeWhenRestartFailsBeforeWorkerAsync();
        await SessionRestoresHostBeforeBridgeAdmissionAsync();
        Console.WriteLine("Desktop update restart session self-tests passed.");
    }

    private static async Task GateRejectsNewWorkAndDrainsExistingAsync()
    {
        var gate = new DesktopBridgeDrainGate();
        Assert(gate.TryEnter(out var lease) && lease is not null, "first bridge request should enter");
        var drain = gate.QuiesceAndDrainAsync(timeout: TimeSpan.FromSeconds(2));
        await Task.Delay(25);
        Assert(!drain.IsCompleted, "drain must wait for admitted request");
        Assert(!gate.TryEnter(out _), "quiesced gate must reject new requests");
        lease!.Dispose();
        await drain;
        Assert(gate.ActiveRequests == 0 && !gate.IsAccepting, "gate should be drained but remain quiesced");
        await gate.ResumeAsync();
        Assert(gate.IsAccepting, "gate should accept after resume");
    }

    private static async Task SessionOrdersDrainBeforePrepareAndExitAsync()
    {
        var gate = new DesktopBridgeDrainGate();
        var events = new List<string>();
        var state = State();
        var session = new DesktopUpdateRestartSession(gate, async (s, quiesce, prepare, exit, resume, ct) =>
        {
            Assert(ReferenceEquals(s, state), "session must preserve transaction state");
            events.Add("quiesce");
            await quiesce(ct);
            events.Add("prepare");
            await prepare(ct);
            events.Add("exit");
            exit();
            return Result(s);
        });

        Assert(session.TryEnterBridgeRequest(out var lease) && lease is not null, "bridge request should enter before restart");
        var restart = session.RestartAsync(state, _ => { events.Add("prepared-host"); return Task.CompletedTask; }, () => events.Add("requested-exit"));
        await Task.Delay(25);
        Assert(events.SequenceEqual(new[] { "quiesce" }), "prepare must not run before bridge drain");
        lease!.Dispose();
        var result = await restart;
        Assert(result.TransactionId == state.TransactionId, "restart result should preserve transaction id");
        Assert(events.SequenceEqual(new[] { "quiesce", "prepare", "prepared-host", "exit", "requested-exit" }), "restart ordering changed");
        Assert(!gate.IsAccepting, "successful restart must remain fail-closed");
    }

    private static async Task SessionResumesBridgeWhenRestartFailsBeforeWorkerAsync()
    {
        var gate = new DesktopBridgeDrainGate();
        var state = State();
        var session = new DesktopUpdateRestartSession(gate, async (s, quiesce, prepare, exit, resume, ct) =>
        {
            await quiesce(ct);
            try
            {
                await prepare(ct);
                throw new InvalidOperationException("injected pre-worker failure");
            }
            catch
            {
                await resume(CancellationToken.None);
                throw;
            }
        });

        try
        {
            await session.RestartAsync(state, _ => Task.CompletedTask, () => throw new Exception("must not exit"));
            throw new Exception("expected injected failure");
        }
        catch (InvalidOperationException ex) when (ex.Message.Contains("injected", StringComparison.Ordinal)) { }

        Assert(gate.IsAccepting, "bridge must resume after failure before updater ownership");
        Assert(session.TryEnterBridgeRequest(out var lease) && lease is not null, "bridge should accept retry after safe resume");
        lease!.Dispose();
    }

    private static async Task SessionRestoresHostBeforeBridgeAdmissionAsync()
    {
        var gate = new DesktopBridgeDrainGate();
        var state = State();
        var hostReady = false;
        var session = new DesktopUpdateRestartSession(gate, async (s, quiesce, prepare, exit, resume, ct) =>
        {
            await quiesce(ct);
            try
            {
                await prepare(ct);
                throw new InvalidOperationException("restore-order-test");
            }
            catch
            {
                await resume(CancellationToken.None);
                throw;
            }
        });

        try
        {
            await session.RestartAsync(
                state,
                _ => Task.CompletedTask,
                () => throw new Exception("must not exit"),
                _ =>
                {
                    Assert(!gate.IsAccepting, "bridge must stay closed while host resources are restored");
                    hostReady = true;
                    return Task.CompletedTask;
                });
            throw new Exception("expected restore-order failure");
        }
        catch (InvalidOperationException ex) when (ex.Message.Contains("restore-order-test", StringComparison.Ordinal)) { }

        Assert(hostReady, "host restore callback must run on safe pre-worker failure");
        Assert(gate.IsAccepting, "bridge opens only after host restoration completes");
    }

    private static UpdateTransactionJournal.TransactionState State() => new(
        "2.0.0-test", new Version(1, 0, 0), new Version(2, 0, 0), "prepared",
        Path.GetFullPath("current"), Path.GetFullPath("package.zip"), new string('a', 64), 1024,
        Path.GetFullPath(Path.Combine("transactions", "2.0.0-test", "transaction.json")),
        DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow, null);

    private static DesktopUpdateRestartLifecycle.RestartLifecycleResult Result(UpdateTransactionJournal.TransactionState state) => new(
        DesktopUpdateRestartLifecycle.LifecycleSchema, state.TransactionId, state.TargetVersion, 101, 202,
        "worker.exe", "shutdown.json", DateTimeOffset.UtcNow.AddMinutes(1), true, true);

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("SELFTEST_FAILED: " + message);
    }
}
