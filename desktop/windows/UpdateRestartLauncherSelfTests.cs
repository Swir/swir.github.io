using System.Security.Cryptography;
using System.Text;
using Swir.Desktop.Host;

internal static class UpdateRestartLauncherSelfTests
{
    private static int _passed;

    private static void Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-update-restart-selftest-" + Guid.NewGuid().ToString("N"));
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
            var package = Encoding.UTF8.GetBytes("SWIR-RESTART-LAUNCHER-TEST");
            File.WriteAllBytes(packagePath, package);
            var hash = Convert.ToHexString(SHA256.HashData(package)).ToLowerInvariant();
            var journal = new UpdateTransactionJournal(transactionsRoot);

            var prepared = journal.Begin(NewPlan(root, installRoot, packagePath, hash, package.Length));
            var handoff = new HostShutdownHandoff(journal, _ => false, _ => { });
            var starter = new RecordingStarter(9191);
            var launcher = new UpdateRestartLauncher(handoff, starter, () => 8181);
            var launched = launcher.Start(prepared, workerPath, transactionsRoot, deploymentRoot, TimeSpan.FromSeconds(30));

            Expect(launched.Schema == UpdateRestartLauncher.RestartSchema, "restart launcher reports stable schema");
            Expect(launched.HostProcessId == 8181 && launched.UpdaterProcessId == 9191, "restart launcher binds old host and updater process ids");
            Expect(starter.LastSpec is not null, "restart launcher invokes updater process starter");
            var spec = starter.LastSpec!;
            Expect(spec.Arguments.Count == 7 && spec.Arguments[0] == "activate-and-launch", "restart launcher uses guarded activate-and-launch command");
            Expect(spec.Arguments.Contains(prepared.JournalPath), "restart launcher passes canonical transaction journal");
            Expect(spec.Environment.TryGetValue(HostShutdownHandoff.NonceEnvironmentVariable, out var nonce) && nonce.Length == 64, "restart launcher passes shutdown nonce only through process environment");
            Expect(!spec.Arguments.Any(arg => string.Equals(arg, nonce, StringComparison.Ordinal)), "shutdown nonce never appears in command line arguments");
            Expect(File.Exists(launched.TicketPath), "restart launcher persists shutdown ticket for worker acquisition");
            Expect(!File.ReadAllText(launched.TicketPath).Contains(nonce, StringComparison.OrdinalIgnoreCase), "restart ticket persists only nonce hash");

            var failurePrepared = journal.Begin(NewPlan(root, installRoot, packagePath, hash, package.Length));
            var failureHandoff = new HostShutdownHandoff(journal, _ => false, _ => { });
            var failingLauncher = new UpdateRestartLauncher(failureHandoff, new ThrowingStarter(), () => 7171);
            try
            {
                failingLauncher.Start(failurePrepared, workerPath, transactionsRoot, deploymentRoot, TimeSpan.FromSeconds(30));
                throw new Exception("FAILED: failed worker start should throw");
            }
            catch (InvalidOperationException)
            {
                Expect(true, "worker start failure is surfaced to caller");
            }
            var failureTicket = Path.Combine(Path.GetDirectoryName(failurePrepared.JournalPath)!, "shutdown.json");
            Expect(!File.Exists(failureTicket), "failed updater start revokes unused shutdown ticket for safe retry");

            var invalidPrepared = journal.Begin(NewPlan(root, installRoot, packagePath, hash, package.Length));
            ExpectCode("UPDATE_RESTART_WORKER_INVALID", () => launcher.Start(invalidPrepared, Path.Combine(root, "missing.exe"), transactionsRoot, deploymentRoot), "restart launcher rejects missing updater executable");

            Console.WriteLine($"SWIR Desktop Update Restart Launcher self-tests passed: {_passed}");
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    private static UpdateHandoffBroker.HandoffPlan NewPlan(string root, string installRoot, string packagePath, string hash, long packageLength)
        => new(
            "0.5.2-restart-" + Guid.NewGuid().ToString("N"),
            new Version(0, 5, 1),
            new Version(0, 5, 2),
            "stable",
            packagePath,
            hash,
            packageLength,
            "restart-selftest-2026",
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

    private sealed class ThrowingStarter : UpdateRestartLauncher.IUpdaterProcessStarter
    {
        public int Start(UpdateRestartLauncher.UpdaterProcessSpec spec) => throw new InvalidOperationException("synthetic start failure");
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
