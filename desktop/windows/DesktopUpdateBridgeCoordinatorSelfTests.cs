namespace Swir.Desktop.Host.SelfTests;

internal static class DesktopUpdateBridgeCoordinatorSelfTests
{
    public static async Task<int> Main()
    {
        try
        {
            await RejectsUntrustedShell();
            await KeepsPrepareReadOnlyAndSingleFlight();
            await ReadinessFailureReopensGate();
            await ExecutionFailureReopensGate();
            await SuccessfulExecutionLatchesHandoff();
            Console.WriteLine("SWIR Desktop Update Bridge coordinator self-tests: PASS");
            Console.WriteLine("- trusted-shell gate");
            Console.WriteLine("- read-only prepare / execute-after-response split");
            Console.WriteLine("- single-flight queueing");
            Console.WriteLine("- readiness failure retry");
            Console.WriteLine("- pre-handoff execution failure retry");
            Console.WriteLine("- successful handoff latch");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("SWIR Desktop Update Bridge coordinator self-tests: FAIL");
            Console.Error.WriteLine(ex);
            return 1;
        }
    }

    private static Task RejectsUntrustedShell()
    {
        var coordinator = Create(out _, out _);
        ExpectCode("UPDATE_BRIDGE_TRUST_REQUIRED", () => coordinator.PrepareApply(false));
        return Task.CompletedTask;
    }

    private static async Task KeepsPrepareReadOnlyAndSingleFlight()
    {
        var coordinator = Create(out var readinessCalls, out var executeCalls);
        var accepted = coordinator.PrepareApply(true);
        Require(accepted.Accepted && accepted.ExecuteAfterBridgeResponse, "prepare did not return deferred acceptance");
        Require(readinessCalls() == 1, "readiness preflight was not executed exactly once");
        Require(executeCalls() == 0, "prepare must never execute restart work while bridge lease is held");
        ExpectCode("UPDATE_RESTART_ALREADY_QUEUED", () => coordinator.PrepareApply(true));
        await coordinator.ExecuteQueuedAsync();
        Require(executeCalls() == 1, "queued restart did not execute exactly once");
    }

    private static Task ReadinessFailureReopensGate()
    {
        var attempts = 0;
        var coordinator = new Swir.Desktop.Host.DesktopUpdateBridgeCoordinator(
            () => new { ok = true },
            () => { if (++attempts == 1) throw new InvalidOperationException("not ready"); },
            _ => Task.CompletedTask);
        try { coordinator.PrepareApply(true); throw new InvalidOperationException("readiness failure was not propagated"); }
        catch (InvalidOperationException ex) when (ex.Message == "not ready") { }
        var accepted = coordinator.PrepareApply(true);
        Require(accepted.Accepted, "gate did not reopen after readiness failure");
        return Task.CompletedTask;
    }

    private static async Task ExecutionFailureReopensGate()
    {
        var attempts = 0;
        var coordinator = new Swir.Desktop.Host.DesktopUpdateBridgeCoordinator(
            () => new { ok = true },
            () => { },
            _ => ++attempts == 1 ? Task.FromException(new InvalidOperationException("handoff failed")) : Task.CompletedTask);
        coordinator.PrepareApply(true);
        try { await coordinator.ExecuteQueuedAsync(); throw new InvalidOperationException("execution failure was not propagated"); }
        catch (InvalidOperationException ex) when (ex.Message == "handoff failed") { }
        coordinator.PrepareApply(true);
        await coordinator.ExecuteQueuedAsync();
        Require(attempts == 2, "gate did not permit retry after pre-handoff execution failure");
    }

    private static async Task SuccessfulExecutionLatchesHandoff()
    {
        var coordinator = Create(out _, out _);
        coordinator.PrepareApply(true);
        await coordinator.ExecuteQueuedAsync();
        ExpectCode("UPDATE_RESTART_ALREADY_QUEUED", () => coordinator.PrepareApply(true));
        try
        {
            await coordinator.ExecuteQueuedAsync();
            throw new InvalidOperationException("second execution unexpectedly succeeded");
        }
        catch (Swir.Desktop.Host.DesktopUpdateBridgeCommandException ex) when (ex.Code == "UPDATE_RESTART_NOT_QUEUED") { }
    }

    private static Swir.Desktop.Host.DesktopUpdateBridgeCoordinator Create(out Func<int> readinessCalls, out Func<int> executeCalls)
    {
        var readiness = 0;
        var execute = 0;
        readinessCalls = () => readiness;
        executeCalls = () => execute;
        return new Swir.Desktop.Host.DesktopUpdateBridgeCoordinator(
            () => new { readiness = "ready" },
            () => readiness++,
            _ => { execute++; return Task.CompletedTask; });
    }

    private static void ExpectCode(string code, Action action)
    {
        try
        {
            action();
            throw new InvalidOperationException($"Expected {code} was not thrown.");
        }
        catch (Swir.Desktop.Host.DesktopUpdateBridgeCommandException ex) when (ex.Code == code) { }
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
