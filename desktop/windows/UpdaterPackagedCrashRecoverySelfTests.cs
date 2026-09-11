using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Swir.Desktop.Host;

internal static class UpdaterPackagedCrashRecoverySelfTests
{
    private const int CrashExitCode = 93;
    private static int _passed;

    private static int Main(string[] args)
    {
        if (args.Length != 3)
        {
            Console.Error.WriteLine("Usage: SWIR.Desktop.Updater.PackagedCrashRecovery.SelfTests <updater-worker-exe> <candidate-publish-dir> <activation-crash-harness-exe>");
            return 2;
        }

        var workerExe = Path.GetFullPath(args[0]);
        var candidatePublishDir = Path.GetFullPath(args[1]);
        var crashHarnessExe = Path.GetFullPath(args[2]);
        if (!File.Exists(workerExe) || !Directory.Exists(candidatePublishDir) || !File.Exists(crashHarnessExe))
        {
            Console.Error.WriteLine("Updater worker, packaged candidate, or activation crash harness is missing.");
            return 2;
        }

        try
        {
            RunInterruptedApplyingScenario(workerExe, candidatePublishDir, crashHarnessExe, "after-journal-applying", expectCandidatePromoted: false, expectPrevious: false);
            RunInterruptedApplyingScenario(workerExe, candidatePublishDir, crashHarnessExe, "after-current-backup", expectCandidatePromoted: false, expectPrevious: true);
            RunInterruptedApplyingScenario(workerExe, candidatePublishDir, crashHarnessExe, "after-candidate-promote", expectCandidatePromoted: true, expectPrevious: true);
            RunPersistedRollbackPendingScenario(workerExe, candidatePublishDir);
            Console.WriteLine($"SWIR packaged updater crash-recovery E2E self-tests passed: {_passed}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("SWIR packaged updater crash-recovery E2E self-tests: FAIL");
            Console.Error.WriteLine(ex);
            return 1;
        }
    }

    private static void RunInterruptedApplyingScenario(
        string workerExe,
        string candidatePublishDir,
        string crashHarnessExe,
        string failurePoint,
        bool expectCandidatePromoted,
        bool expectPrevious)
    {
        using var fixture = CreateFixture(candidatePublishDir, "healthy", "0.5.2");
        Prepare(workerExe, fixture);
        var plan = ReadPlan(fixture);

        var crash = RunProcess(crashHarnessExe, new[]
        {
            fixture.Prepared.JournalPath,
            fixture.TransactionsRoot,
            fixture.DeploymentRoot,
            failurePoint
        }, 15000);
        Expect(crash.ExitCode == CrashExitCode, $"{failurePoint}: crash harness terminates at the requested persisted boundary");

        var interrupted = fixture.Journal.Read(fixture.Prepared.JournalPath);
        Expect(interrupted.State == "applying", $"{failurePoint}: journal remains applying after abrupt process termination");
        Expect(Directory.Exists(plan.PreviousRoot) == expectPrevious, $"{failurePoint}: Previous slot reflects the exact interrupted swap phase");

        if (expectCandidatePromoted)
        {
            Expect(File.Exists(Path.Combine(plan.CurrentRoot, "e2e-mode.txt")), $"{failurePoint}: Candidate reached Current before the crash");
            Expect(!Directory.Exists(Path.Combine(plan.CandidateRoot, "Payload")), $"{failurePoint}: promoted Candidate payload left its staging slot");
        }
        else
        {
            Expect(Directory.Exists(Path.Combine(plan.CandidateRoot, "Payload")), $"{failurePoint}: Candidate payload remains staged before promotion");
        }

        var recovery = new DesktopStartupRecovery(fixture.TransactionsRoot, fixture.DeploymentRoot);
        var report = recovery.RecoverBeforeShellStart();
        Expect(report.IncompleteTransactions == 1 && report.ChangedTransactions == 1, $"{failurePoint}: startup recovery reconciles the interrupted transaction");

        var recovered = fixture.Journal.Read(fixture.Prepared.JournalPath);
        if (!expectPrevious)
        {
            Expect(recovered.State == "failed", $"{failurePoint}: pre-swap interruption fails closed without moving Current");
            Expect(report.Items[0].Action == "interrupted-before-swap-marked-failed", $"{failurePoint}: recovery reports pre-swap failure");
            Expect(File.ReadAllText(Path.Combine(plan.CurrentRoot, "version.txt")).Trim() == "0.5.1", $"{failurePoint}: known-good Current remains untouched");
            Expect(!Directory.Exists(plan.PreviousRoot), $"{failurePoint}: no synthetic Previous slot is created");
        }
        else
        {
            Expect(recovered.State == "rolled-back", $"{failurePoint}: interrupted swap rolls back to terminal state");
            Expect(report.Items[0].Action == "interrupted-activation-rolled-back", $"{failurePoint}: recovery reports interrupted activation rollback");
            Expect(File.ReadAllText(Path.Combine(plan.CurrentRoot, "version.txt")).Trim() == "0.5.1", $"{failurePoint}: Previous is restored as known-good Current");
            Expect(!Directory.Exists(plan.PreviousRoot), $"{failurePoint}: Previous is consumed after rollback");

            var abandoned = Path.Combine(plan.CandidateRoot, "AbandonedCurrent");
            Expect(Directory.Exists(abandoned) == expectCandidatePromoted, $"{failurePoint}: quarantine exists only when Candidate had already reached Current");
            if (expectCandidatePromoted)
                Expect(File.ReadAllText(Path.Combine(abandoned, "e2e-mode.txt")).Trim() == "healthy", $"{failurePoint}: quarantined Current is the interrupted Candidate");
        }
    }

    private static void RunPersistedRollbackPendingScenario(string workerExe, string candidatePublishDir)
    {
        using var fixture = CreateFixture(candidatePublishDir, "no-health", "0.5.2");
        Prepare(workerExe, fixture);
        var plan = ReadPlan(fixture);
        var state = fixture.Journal.Read(fixture.Prepared.JournalPath);
        var shutdown = IssueShutdownTicket(fixture.Journal, state);
        var environment = new Dictionary<string, string?>
        {
            [HostShutdownHandoff.NonceEnvironmentVariable] = shutdown.Nonce
        };

        var activation = RunWorker(workerExe, environment, "activate-and-launch", fixture.Prepared.JournalPath, fixture.TransactionsRoot, fixture.DeploymentRoot, 20000);
        Expect(activation.ExitCode == 0, "rollback-pending: no-health Candidate reaches awaiting-health-check");

        var awaiting = fixture.Journal.Read(fixture.Prepared.JournalPath);
        Expect(awaiting.State == "awaiting-health-check", "rollback-pending: transaction waits for health proof");
        var evidencePath = Path.Combine(plan.CurrentRoot, "candidate-evidence.json");
        WaitForFile(evidencePath, TimeSpan.FromSeconds(5));
        using (var evidence = JsonDocument.Parse(File.ReadAllText(evidencePath)))
            WaitForProcessExit(evidence.RootElement.GetProperty("processId").GetInt32(), TimeSpan.FromSeconds(8));

        var timeoutClock = () => DateTimeOffset.UtcNow.AddMinutes(10);
        var pending = new UpdateHealthBroker(fixture.Journal, timeoutClock).EvaluateTimeout(awaiting);
        Expect(pending.State == "rollback-pending", "rollback-pending: timeout decision is durably journaled before rollback");
        Expect(File.Exists(Path.Combine(plan.CurrentRoot, "e2e-mode.txt")), "rollback-pending: untrusted Candidate is still Current at simulated crash boundary");
        Expect(File.Exists(Path.Combine(plan.PreviousRoot, "version.txt")), "rollback-pending: known-good Previous remains available at crash boundary");

        var recovery = new DesktopStartupRecovery(fixture.TransactionsRoot, fixture.DeploymentRoot, timeoutClock);
        var report = recovery.RecoverBeforeShellStart();
        Expect(report.Items.Count == 1 && report.Items[0].Action == "pending-rollback-completed", "rollback-pending: next startup completes persisted rollback");
        Expect(fixture.Journal.Read(fixture.Prepared.JournalPath).State == "rolled-back", "rollback-pending: transaction reaches rolled-back terminal state");
        Expect(File.ReadAllText(Path.Combine(plan.CurrentRoot, "version.txt")).Trim() == "0.5.1", "rollback-pending: known-good Current is restored");
        Expect(!Directory.Exists(plan.PreviousRoot), "rollback-pending: Previous is consumed after recovery");
        var failed = Path.Combine(plan.CandidateRoot, "FailedCurrent");
        Expect(File.Exists(Path.Combine(failed, "e2e-mode.txt")), "rollback-pending: failed Candidate is quarantined");
    }

    private static void Prepare(string workerExe, Fixture fixture)
    {
        Expect(RunWorker(workerExe, null, "plan", fixture.Prepared.JournalPath, fixture.TransactionsRoot, fixture.DeploymentRoot).ExitCode == 0,
            "fixture writes canonical worker plan");
        Expect(RunWorker(workerExe, null, "prepare-candidate", fixture.Prepared.JournalPath, fixture.TransactionsRoot, fixture.DeploymentRoot).ExitCode == 0,
            "fixture prepares verified packaged Candidate");
    }

    private static UpdaterWorkerProtocol.WorkerPlan ReadPlan(Fixture fixture)
    {
        var state = fixture.Journal.Read(fixture.Prepared.JournalPath);
        var path = Path.Combine(Path.GetDirectoryName(fixture.Prepared.JournalPath)!, "worker-plan.json");
        return new UpdaterWorkerProtocol(fixture.Journal, fixture.DeploymentRoot).Read(path, state);
    }

    private static Fixture CreateFixture(string candidatePublishDir, string mode, string targetVersion)
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-packaged-crash-recovery-e2e-" + Guid.NewGuid().ToString("N"));
        var transactionsRoot = Path.Combine(root, "transactions");
        var deploymentRoot = Path.Combine(root, "deployment");
        var currentRoot = Path.Combine(deploymentRoot, "Current");
        Directory.CreateDirectory(currentRoot);
        File.WriteAllText(Path.Combine(currentRoot, "version.txt"), "0.5.1", Encoding.UTF8);

        var packagePath = Path.Combine(root, $"candidate-{mode}.zip");
        CreatePackageFromPublish(candidatePublishDir, packagePath, targetVersion, mode);
        var journal = new UpdateTransactionJournal(transactionsRoot);
        var prepared = Begin(journal, root, packagePath, targetVersion);
        return new Fixture(root, transactionsRoot, deploymentRoot, journal, prepared);
    }

    private static UpdateTransactionJournal.TransactionState Begin(UpdateTransactionJournal journal, string root, string packagePath, string targetVersion)
    {
        var bytes = File.ReadAllBytes(packagePath);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var transactionId = targetVersion + "-packaged-crash-recovery-e2e-" + Guid.NewGuid().ToString("N");
        return journal.Begin(new UpdateHandoffBroker.HandoffPlan(
            transactionId,
            new Version(0, 5, 1),
            Version.Parse(targetVersion),
            "stable",
            packagePath,
            hash,
            bytes.LongLength,
            "packaged-crash-recovery-e2e-2026",
            Path.Combine(root, "installed"),
            Path.Combine(root, transactionId + "-handoff.json"),
            DateTimeOffset.UtcNow,
            "prepared"));
    }

    private static void CreatePackageFromPublish(string publishDir, string path, string version, string mode)
    {
        var files = Directory.GetFiles(publishDir, "*", SearchOption.AllDirectories)
            .Where(file => !file.EndsWith(".pdb", StringComparison.OrdinalIgnoreCase))
            .ToDictionary(file => Path.GetRelativePath(publishDir, file).Replace('\\', '/'), File.ReadAllBytes, StringComparer.OrdinalIgnoreCase);
        files["e2e-mode.txt"] = Encoding.UTF8.GetBytes(mode);

        using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
        var manifestFiles = files.Select(pair => new CandidatePackagePreparer.PackageFile(
            pair.Key,
            Convert.ToHexString(SHA256.HashData(pair.Value)).ToLowerInvariant(),
            pair.Value.LongLength)).ToList();
        var manifest = new CandidatePackagePreparer.PackageManifest(
            CandidatePackagePreparer.PackageManifestSchema,
            version,
            "SWIR.Desktop.E2ECandidate.exe",
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

    private static HostShutdownHandoff.ShutdownTicket IssueShutdownTicket(UpdateTransactionJournal journal, UpdateTransactionJournal.TransactionState state)
    {
        using var dead = Process.Start(new ProcessStartInfo("cmd.exe", "/d /c exit 0") { UseShellExecute = false, CreateNoWindow = true })
            ?? throw new InvalidOperationException("Could not create completed host process for shutdown handoff E2E.");
        dead.WaitForExit();
        return new HostShutdownHandoff(journal, _ => false, _ => { }).Issue(state, dead.Id, TimeSpan.FromSeconds(30));
    }

    private static ProcessResult RunWorker(string workerExe, IReadOnlyDictionary<string, string?>? environment, string command, string journal, string transactionsRoot, string deploymentRoot, int timeoutMs = 15000)
    {
        var args = new[] { command, "--journal", journal, "--transactions-root", transactionsRoot, "--deployment-root", deploymentRoot };
        return RunProcess(workerExe, args, timeoutMs, environment);
    }

    private static ProcessResult RunProcess(string executable, IEnumerable<string> args, int timeoutMs, IReadOnlyDictionary<string, string?>? environment = null)
    {
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        if (environment is not null)
            foreach (var pair in environment) start.Environment[pair.Key] = pair.Value;

        using var process = Process.Start(start) ?? throw new InvalidOperationException($"Could not start process: {executable}");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(timeoutMs))
        {
            try { process.Kill(true); } catch { }
            throw new TimeoutException($"Process exceeded {timeoutMs}ms timeout: {executable}");
        }
        Task.WaitAll(stdoutTask, stderrTask);
        return new ProcessResult(process.ExitCode, stdoutTask.Result.Trim(), stderrTask.Result.Trim());
    }

    private static void WaitForFile(string path, TimeSpan timeout)
    {
        var stopwatch = Stopwatch.StartNew();
        while (!File.Exists(path) && stopwatch.Elapsed < timeout) Thread.Sleep(50);
        if (!File.Exists(path)) throw new TimeoutException($"Expected Candidate evidence was not created: {path}");
    }

    private static void WaitForProcessExit(int pid, TimeSpan timeout)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            if (!process.WaitForExit((int)timeout.TotalMilliseconds))
            {
                try { process.Kill(true); } catch { }
                throw new TimeoutException($"Candidate process {pid} did not exit in time.");
            }
        }
        catch (ArgumentException) { }
    }

    private static void Expect(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException("FAILED: " + name);
        _passed++;
        Console.WriteLine("PASS: " + name);
    }

    private sealed record ProcessResult(int ExitCode, string Stdout, string Stderr);

    private sealed class Fixture : IDisposable
    {
        public Fixture(string root, string transactionsRoot, string deploymentRoot, UpdateTransactionJournal journal, UpdateTransactionJournal.TransactionState prepared)
            => (Root, TransactionsRoot, DeploymentRoot, Journal, Prepared) = (root, transactionsRoot, deploymentRoot, journal, prepared);
        public string Root { get; }
        public string TransactionsRoot { get; }
        public string DeploymentRoot { get; }
        public UpdateTransactionJournal Journal { get; }
        public UpdateTransactionJournal.TransactionState Prepared { get; }
        public void Dispose() { try { if (Directory.Exists(Root)) Directory.Delete(Root, true); } catch { } }
    }
}
