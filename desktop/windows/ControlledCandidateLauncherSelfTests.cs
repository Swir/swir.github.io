using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Swir.Desktop.Host;

internal static class ControlledCandidateLauncherSelfTests
{
    private static int _passed;

    private static void Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-candidate-launcher-selftest-" + Guid.NewGuid().ToString("N"));
        var installRoot = Path.Combine(root, "installed");
        var transactionsRoot = Path.Combine(root, "transactions");
        var deploymentRoot = Path.Combine(root, "deployment");
        try
        {
            Directory.CreateDirectory(installRoot);
            var journal = new UpdateTransactionJournal(transactionsRoot);
            var protocol = new UpdaterWorkerProtocol(journal, deploymentRoot);
            var preparer = new CandidatePackagePreparer();

            ResetDeployment(deploymentRoot, "KNOWN-GOOD-0.5.1");
            var success = Prepare(root, installRoot, journal, protocol, preparer, "0.5.20", "launch-success.zip");
            var successActivator = new DeploymentSlotActivator(journal, preparer);
            var successHealth = new UpdateHealthBroker(journal);
            var ready = new UpdateActivationCoordinator(journal, successActivator, successHealth)
                .ActivateAndIssueHealth(success.Plan, success.Candidate, TimeSpan.FromMinutes(2));
            var starter = new FakeStarter(exitDuringProbe: false);
            var launcher = new ControlledCandidateLauncher(journal, successActivator, starter);
            var launched = launcher.Launch(success.Plan, success.Candidate, ready, TimeSpan.FromMilliseconds(1));

            Expect(launched.Schema == ControlledCandidateLauncher.LaunchSchema, "launcher persists versioned launch schema");
            Expect(launched.ProcessId == 4242 && launched.Phase == "started", "launcher records candidate process identity");
            Expect(starter.LastSpec is not null, "launcher delegates process creation through controlled starter");
            Expect(Path.GetFullPath(starter.LastSpec!.FileName).StartsWith(Path.GetFullPath(success.Plan.CurrentRoot) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase), "launcher executes only entry point inside Current slot");
            Expect(starter.LastSpec.WorkingDirectory == Path.GetFullPath(success.Plan.CurrentRoot), "candidate working directory is pinned to Current slot");
            Expect(starter.LastSpec.Environment[ControlledCandidateLauncher.TransactionEnvironment] == success.Plan.TransactionId, "transaction id is passed to candidate process");
            Expect(starter.LastSpec.Environment[ControlledCandidateLauncher.TargetVersionEnvironment] == success.Plan.TargetVersion.ToString(), "target version is passed to candidate process");
            Expect(starter.LastSpec.Environment[ControlledCandidateLauncher.HealthTokenEnvironment] == ready.HealthChallenge.Token, "health token is delivered through process environment");
            var launchJson = File.ReadAllText(launched.LaunchPath);
            Expect(!launchJson.Contains(ready.HealthChallenge.Token, StringComparison.Ordinal), "raw health token is never persisted in launch metadata");
            Expect(journal.Read(success.Prepared.JournalPath).State == "awaiting-health-check", "successful process start leaves transaction pending health confirmation");

            ResetDeployment(deploymentRoot, "KNOWN-GOOD-START-FAIL");
            var startFailure = Prepare(root, installRoot, journal, protocol, preparer, "0.5.21", "launch-start-failure.zip");
            var failureActivator = new DeploymentSlotActivator(journal, preparer);
            var failureReady = new UpdateActivationCoordinator(journal, failureActivator, new UpdateHealthBroker(journal))
                .ActivateAndIssueHealth(startFailure.Plan, startFailure.Candidate, TimeSpan.FromMinutes(2));
            var throwingStarter = new FakeStarter(startException: new InvalidOperationException("simulated start failure"));
            ExpectCode("UPDATE_LAUNCH_START_FAILED",
                () => new ControlledCandidateLauncher(journal, failureActivator, throwingStarter).Launch(startFailure.Plan, startFailure.Candidate, failureReady, TimeSpan.Zero),
                "process start failure is surfaced as controlled updater error");
            Expect(journal.Read(startFailure.Prepared.JournalPath).State == "rolled-back", "process start failure rolls transaction back immediately");
            Expect(File.ReadAllText(Path.Combine(startFailure.Plan.CurrentRoot, "version.txt")) == "KNOWN-GOOD-START-FAIL", "process start failure restores known-good Previous slot");
            Expect(Directory.Exists(Path.Combine(startFailure.Plan.CandidateRoot, "FailedCurrent")), "failed promoted candidate is quarantined after start failure");

            ResetDeployment(deploymentRoot, "KNOWN-GOOD-EARLY-EXIT");
            var earlyExit = Prepare(root, installRoot, journal, protocol, preparer, "0.5.22", "launch-early-exit.zip");
            var earlyActivator = new DeploymentSlotActivator(journal, preparer);
            var earlyReady = new UpdateActivationCoordinator(journal, earlyActivator, new UpdateHealthBroker(journal))
                .ActivateAndIssueHealth(earlyExit.Plan, earlyExit.Candidate, TimeSpan.FromMinutes(2));
            var earlyStarter = new FakeStarter(exitDuringProbe: true, exitCode: 17);
            ExpectCode("UPDATE_LAUNCH_EARLY_EXIT",
                () => new ControlledCandidateLauncher(journal, earlyActivator, earlyStarter).Launch(earlyExit.Plan, earlyExit.Candidate, earlyReady, TimeSpan.FromMilliseconds(1)),
                "very early candidate exit triggers immediate rollback");
            Expect(journal.Read(earlyExit.Prepared.JournalPath).State == "rolled-back", "early exit cannot strand transaction in awaiting-health-check");
            Expect(File.ReadAllText(Path.Combine(earlyExit.Plan.CurrentRoot, "version.txt")) == "KNOWN-GOOD-EARLY-EXIT", "early-exit rollback restores known-good deployment");
            var earlyLaunchPath = Path.Combine(Path.GetDirectoryName(earlyExit.Prepared.JournalPath)!, "launch.json");
            using var earlyDocument = JsonDocument.Parse(File.ReadAllText(earlyLaunchPath));
            Expect(earlyDocument.RootElement.GetProperty("Phase").GetString() == "early-exit", "launch diagnostics persist early-exit phase");
            Expect(earlyDocument.RootElement.GetProperty("ExitCode").GetInt32() == 17, "launch diagnostics persist early process exit code");

            Console.WriteLine($"SWIR controlled candidate launcher self-tests passed: {_passed}");
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    private static PreparedCandidate Prepare(
        string root,
        string installRoot,
        UpdateTransactionJournal journal,
        UpdaterWorkerProtocol protocol,
        CandidatePackagePreparer preparer,
        string version,
        string fileName)
    {
        var package = Path.Combine(root, fileName);
        CreatePackage(package, version);
        var bytes = File.ReadAllBytes(package);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var transactionId = version + "-" + Guid.NewGuid().ToString("N");
        var handoff = new UpdateHandoffBroker.HandoffPlan(
            transactionId,
            new Version(0, 5, 1),
            Version.Parse(version),
            "stable",
            package,
            hash,
            bytes.LongLength,
            "launcher-selftest",
            installRoot,
            Path.Combine(root, transactionId + "-handoff.json"),
            DateTimeOffset.UtcNow,
            "prepared");
        var prepared = journal.Begin(handoff);
        var plan = protocol.Prepare(prepared);
        var candidate = preparer.Prepare(plan);
        return new PreparedCandidate(prepared, plan, candidate);
    }

    private static void CreatePackage(string path, string version)
    {
        var files = new Dictionary<string, byte[]>
        {
            ["SWIR.Desktop.Host.exe"] = Encoding.UTF8.GetBytes("FAKE-HOST-" + version),
            ["assets/runtime.txt"] = Encoding.UTF8.GetBytes("RUNTIME-" + version)
        };
        using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
        var manifestFiles = files.Select(pair => new CandidatePackagePreparer.PackageFile(
            pair.Key,
            Convert.ToHexString(SHA256.HashData(pair.Value)).ToLowerInvariant(),
            pair.Value.LongLength)).ToList();
        var manifest = new CandidatePackagePreparer.PackageManifest(
            CandidatePackagePreparer.PackageManifestSchema,
            version,
            "SWIR.Desktop.Host.exe",
            manifestFiles);
        var manifestEntry = archive.CreateEntry(CandidatePackagePreparer.ManifestEntryName, CompressionLevel.NoCompression);
        using (var writer = new StreamWriter(manifestEntry.Open(), new UTF8Encoding(false)))
            writer.Write(JsonSerializer.Serialize(manifest));
        foreach (var pair in files)
        {
            var entry = archive.CreateEntry(pair.Key, CompressionLevel.Fastest);
            using var stream = entry.Open();
            stream.Write(pair.Value);
        }
    }

    private static void ResetDeployment(string deploymentRoot, string marker)
    {
        var current = Path.Combine(deploymentRoot, "Current");
        var previous = Path.Combine(deploymentRoot, "Previous");
        if (Directory.Exists(current)) Directory.Delete(current, true);
        if (Directory.Exists(previous)) Directory.Delete(previous, true);
        Directory.CreateDirectory(current);
        File.WriteAllText(Path.Combine(current, "version.txt"), marker);
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

    private sealed class FakeStarter : ControlledCandidateLauncher.ICandidateProcessStarter
    {
        private readonly bool _exitDuringProbe;
        private readonly int _exitCode;
        private readonly Exception? _startException;
        public ControlledCandidateLauncher.CandidateProcessSpec? LastSpec { get; private set; }

        public FakeStarter(bool exitDuringProbe = false, int exitCode = 0, Exception? startException = null)
        {
            _exitDuringProbe = exitDuringProbe;
            _exitCode = exitCode;
            _startException = startException;
        }

        public ControlledCandidateLauncher.ICandidateProcessHandle Start(ControlledCandidateLauncher.CandidateProcessSpec spec)
        {
            LastSpec = spec;
            if (_startException is not null) throw _startException;
            return new FakeHandle(_exitDuringProbe, _exitCode);
        }
    }

    private sealed class FakeHandle : ControlledCandidateLauncher.ICandidateProcessHandle
    {
        private readonly bool _exitDuringProbe;
        private readonly int _exitCode;
        public FakeHandle(bool exitDuringProbe, int exitCode) { _exitDuringProbe = exitDuringProbe; _exitCode = exitCode; }
        public int Id => 4242;
        public int? ExitCode => _exitDuringProbe ? _exitCode : null;
        public bool WaitForExit(TimeSpan timeout) => _exitDuringProbe;
        public void Dispose() { }
    }

    private sealed record PreparedCandidate(
        UpdateTransactionJournal.TransactionState Prepared,
        UpdaterWorkerProtocol.WorkerPlan Plan,
        CandidatePackagePreparer.CandidateState Candidate);
}
