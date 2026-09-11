using System.Security.Cryptography;
using System.Text;
using Swir.Desktop.Host;

internal static class DesktopUpdateRestartLifecycleSelfTests
{
    private static int _passed;

    private static async Task Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-restart-lifecycle-selftest-" + Guid.NewGuid().ToString("N"));
        var installRoot = Path.Combine(root, "install");
        var transactionsRoot = Path.Combine(root, "transactions");
        var deploymentRoot = Path.Combine(root, "deployment");
        var packagePath = Path.Combine(root, "package.bin");
        var workerPath = Path.Combine(root, "SWIR.Desktop.UpdaterWorker.exe");
        try
        {
            Directory.CreateDirectory(installRoot);
            Directory.CreateDirectory(transactionsRoot);
            Directory.CreateDirectory(deploymentRoot);
            File.WriteAllText(workerPath, "stub");
            var package = Encoding.UTF8.GetBytes("SWIR-RESTART-LIFECYCLE-TEST");
            File.WriteAllBytes(packagePath, package);
            var hash = Convert.ToHexString(SHA256.HashData(package)).ToLowerInvariant();
            var journal = new UpdateTransactionJournal(transactionsRoot);

            var prepared = journal.Begin(NewPlan(root, installRoot, packagePath, hash, package.Length));
            var starter = new RecordingStarter(9292);
            var launcher = new UpdateRestartLauncher(
                new HostShutdownHandoff(journal, _ => false, _ => { }),
                starter,
                () => 8282);
            var lifecycle = new DesktopUpdateRestartLifecycle(launcher);
            var order = new List<string>();
            var result = await lifecycle.RestartAsync(
                prepared,
                workerPath,
                transactionsRoot,
                deploymentRoot,
                _ => { order.Add("quiesce"); return Task.CompletedTask; },
                _ => { order.Add("prepare"); return Task.CompletedTask; },
                () => order.Add("exit"),
                _ => { order.Add("resume"); return Task.CompletedTask; },
                TimeSpan.FromSeconds(30));

            Expect(result.Schema == DesktopUpdateRestartLifecycle.LifecycleSchema, "lifecycle reports stable schema");
            Expect(order.SequenceEqual(new[] { "quiesce", "prepare", "exit" }), "lifecycle quiesces and prepares before requesting host exit");
            Expect(result.BridgeQuiesced && result.HostExitRequested, "successful lifecycle reports quiesced bridge and requested exit");
            Expect(lifecycle.IsRestartInProgress, "successful lifecycle remains latched until old process exits");
            Expect(starter.LastSpec is not null && starter.LastSpec.Arguments[0] == "activate-and-launch", "lifecycle delegates only to guarded updater launcher");

            ExpectCode("UPDATE_RESTART_ALREADY_IN_PROGRESS", () => lifecycle.RestartAsync(
                prepared,
                workerPath,
                transactionsRoot,
                deploymentRoot,
                _ => Task.CompletedTask,
                _ => Task.CompletedTask,
                () => { }).GetAwaiter().GetResult(),
                "lifecycle rejects a second restart in the same host process");

            var failedPrepared = journal.Begin(NewPlan(root, installRoot, packagePath, hash, package.Length));
            var failedStarter = new RecordingStarter(9393);
            var failedLifecycle = new DesktopUpdateRestartLifecycle(new UpdateRestartLauncher(
                new HostShutdownHandoff(journal, _ => false, _ => { }),
                failedStarter,
                () => 8383));
            var failedOrder = new List<string>();
            try
            {
                await failedLifecycle.RestartAsync(
                    failedPrepared,
                    workerPath,
                    transactionsRoot,
                    deploymentRoot,
                    _ => { failedOrder.Add("quiesce"); return Task.CompletedTask; },
                    _ => { failedOrder.Add("prepare"); throw new IOException("synthetic flush failure"); },
                    () => failedOrder.Add("exit"),
                    _ => { failedOrder.Add("resume"); return Task.CompletedTask; });
                throw new Exception("FAILED: pre-worker prepare failure should be surfaced");
            }
            catch (IOException)
            {
                Expect(true, "pre-worker prepare failure is surfaced");
            }
            Expect(failedOrder.SequenceEqual(new[] { "quiesce", "prepare", "resume" }), "pre-worker failure resumes host service and never requests exit");
            Expect(!failedLifecycle.IsRestartInProgress, "pre-worker failure releases lifecycle for safe retry");
            Expect(failedStarter.LastSpec is null, "updater is not started when host preparation fails");

            var cancelledPrepared = journal.Begin(NewPlan(root, installRoot, packagePath, hash, package.Length));
            var cancelledStarter = new RecordingStarter(9494);
            var cancelledLifecycle = new DesktopUpdateRestartLifecycle(new UpdateRestartLauncher(
                new HostShutdownHandoff(journal, _ => false, _ => { }),
                cancelledStarter,
                () => 8484));
            using var cancellation = new CancellationTokenSource();
            var resumedAfterCancellation = false;
            try
            {
                await cancelledLifecycle.RestartAsync(
                    cancelledPrepared,
                    workerPath,
                    transactionsRoot,
                    deploymentRoot,
                    _ => { cancellation.Cancel(); return Task.CompletedTask; },
                    _ => Task.CompletedTask,
                    () => { },
                    _ => { resumedAfterCancellation = true; return Task.CompletedTask; },
                    cancellationToken: cancellation.Token);
                throw new Exception("FAILED: cancellation should stop restart before worker launch");
            }
            catch (OperationCanceledException)
            {
                Expect(true, "cancellation before worker launch is surfaced");
            }
            Expect(resumedAfterCancellation, "cancellation after quiesce resumes host service");
            Expect(cancelledStarter.LastSpec is null && !cancelledLifecycle.IsRestartInProgress, "cancelled lifecycle does not start updater and remains retryable");

            var exitFailurePrepared = journal.Begin(NewPlan(root, installRoot, packagePath, hash, package.Length));
            var exitFailureStarter = new RecordingStarter(9595);
            var exitFailureLifecycle = new DesktopUpdateRestartLifecycle(new UpdateRestartLauncher(
                new HostShutdownHandoff(journal, _ => false, _ => { }),
                exitFailureStarter,
                () => 8585));
            var resumeCalledAfterWorkerStart = false;
            try
            {
                await exitFailureLifecycle.RestartAsync(
                    exitFailurePrepared,
                    workerPath,
                    transactionsRoot,
                    deploymentRoot,
                    _ => Task.CompletedTask,
                    _ => Task.CompletedTask,
                    () => throw new InvalidOperationException("synthetic close failure"),
                    _ => { resumeCalledAfterWorkerStart = true; return Task.CompletedTask; });
                throw new Exception("FAILED: exit signalling failure should surface");
            }
            catch (InvalidOperationException)
            {
                Expect(true, "exit signalling failure after worker launch is surfaced");
            }
            Expect(exitFailureStarter.LastSpec is not null, "worker was already launched before exit signalling failure");
            Expect(!resumeCalledAfterWorkerStart && exitFailureLifecycle.IsRestartInProgress, "post-worker failure stays fail-closed instead of reopening bridge traffic");

            Console.WriteLine($"SWIR Desktop restart lifecycle self-tests passed: {_passed}");
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    private static UpdateHandoffBroker.HandoffPlan NewPlan(string root, string installRoot, string packagePath, string hash, long packageLength)
        => new(
            "0.5.2-lifecycle-" + Guid.NewGuid().ToString("N"),
            new Version(0, 5, 1),
            new Version(0, 5, 2),
            "stable",
            packagePath,
            hash,
            packageLength,
            "restart-lifecycle-selftest-2026",
            installRoot,
            Path.Combine(root, "handoff-" + Guid.NewGuid().ToString("N") + ".json"),
            DateTimeOffset.UtcNow,
            "prepared");

    private sealed class RecordingStarter : UpdateRestartLauncher.IUpdaterProcessStarter
    {
        private readonly int _pid;
        public RecordingStarter(int pid) => _pid = pid;
        public UpdateRestartLauncher.UpdaterProcessSpec? LastSpec { get; private set; }
        public int Start(UpdateRestartLauncher.UpdaterProcessSpec spec)
        {
            LastSpec = spec;
            return _pid;
        }
    }

    private static void Expect(bool condition, string name)
    {
        if (!condition) throw new Exception("FAILED: " + name);
        _passed++;
        Console.WriteLine("PASS: " + name);
    }

    private static void ExpectCode(string code, Action action, string name)
    {
        try { action(); }
        catch (UpdateSecurityException ex) when (ex.Code == code)
        {
            Expect(true, name);
            return;
        }
        throw new Exception($"FAILED: {name}; expected {code}");
    }
}
