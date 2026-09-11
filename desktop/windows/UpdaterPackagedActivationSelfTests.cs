using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Swir.Desktop.Host;

internal static class UpdaterPackagedActivationSelfTests
{
    private static int _passed;

    private static int Main(string[] args)
    {
        if (args.Length != 2)
        {
            Console.Error.WriteLine("Usage: SWIR.Desktop.Updater.PackagedActivation.SelfTests <updater-worker-exe> <candidate-publish-dir>");
            return 2;
        }

        var workerExe = Path.GetFullPath(args[0]);
        var candidatePublishDir = Path.GetFullPath(args[1]);
        if (!File.Exists(workerExe) || !Directory.Exists(candidatePublishDir))
        {
            Console.Error.WriteLine("Updater worker or packaged candidate publish directory is missing.");
            return 2;
        }

        var candidateExe = Path.Combine(candidatePublishDir, "SWIR.Desktop.E2ECandidate.exe");
        if (!File.Exists(candidateExe))
        {
            Console.Error.WriteLine($"Packaged E2E candidate executable not found: {candidateExe}");
            return 2;
        }

        try
        {
            RunHealthyScenario(workerExe, candidatePublishDir);
            RunRollbackScenario(workerExe, candidatePublishDir);
            Console.WriteLine($"SWIR packaged updater activation E2E self-tests passed: {_passed}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("SWIR packaged updater activation E2E self-tests: FAIL");
            Console.Error.WriteLine(ex);
            return 1;
        }
    }

    private static void RunHealthyScenario(string workerExe, string candidatePublishDir)
    {
        var fixture = CreateFixture(candidatePublishDir, "healthy", "0.5.2");
        try
        {
            var journal = fixture.Journal;
            var prepared = fixture.Prepared;
            var planResult = RunWorker(workerExe, null, "plan", prepared.JournalPath, fixture.TransactionsRoot, fixture.DeploymentRoot);
            Expect(planResult.ExitCode == 0, "healthy scenario writes canonical worker plan");
            var candidateResult = RunWorker(workerExe, null, "prepare-candidate", prepared.JournalPath, fixture.TransactionsRoot, fixture.DeploymentRoot);
            Expect(candidateResult.ExitCode == 0, "healthy scenario prepares packaged candidate");

            var protocol = new UpdaterWorkerProtocol(journal, fixture.DeploymentRoot);
            var state = journal.Read(prepared.JournalPath);
            var planPath = Path.Combine(Path.GetDirectoryName(prepared.JournalPath)!, "worker-plan.json");
            var plan = protocol.Read(planPath, state);
            var shutdown = IssueShutdownTicket(journal, state);
            var environment = new Dictionary<string, string?>
            {
                [HostShutdownHandoff.NonceEnvironmentVariable] = shutdown.Nonce
            };

            var activation = RunWorker(workerExe, environment, "activate-and-launch", prepared.JournalPath, fixture.TransactionsRoot, fixture.DeploymentRoot, 20000);
            Expect(activation.ExitCode == 0, "standalone worker activates and launches healthy packaged candidate");
            using (var json = JsonDocument.Parse(activation.Stdout))
            {
                Expect(json.RootElement.GetProperty("schema").GetString() == "swir.desktop-candidate-launch/0.1", "healthy activation returns launch schema");
                Expect(json.RootElement.GetProperty("shutdownTicketConsumed").GetBoolean(), "healthy activation consumes one-shot shutdown ticket");
                Expect(!json.RootElement.GetProperty("healthTokenPersisted").GetBoolean(), "raw health token is never reported as persisted");
                Expect(!json.RootElement.GetProperty("shutdownNoncePersisted").GetBoolean(), "raw shutdown nonce is never reported as persisted");
            }

            var committed = journal.Read(prepared.JournalPath);
            Expect(string.Equals(committed.State, "committed", StringComparison.Ordinal), "healthy candidate confirms health and commits transaction");
            Expect(File.Exists(Path.Combine(plan.CurrentRoot, "e2e-mode.txt")), "healthy candidate remains promoted in Current");
            Expect(File.ReadAllText(Path.Combine(plan.CurrentRoot, "e2e-mode.txt")).Trim() == "healthy", "Current contains healthy candidate payload");
            Expect(File.Exists(Path.Combine(plan.PreviousRoot, "version.txt")), "Previous retains the known-good deployment after commit");
            Expect(File.ReadAllText(Path.Combine(plan.PreviousRoot, "version.txt")).Trim() == "0.5.1", "Previous contains original known-good version");
            Expect(File.Exists(Path.Combine(Path.GetDirectoryName(prepared.JournalPath)!, "shutdown-consumed.json")), "shutdown authorization cannot be replayed after activation");

            var evidencePath = Path.Combine(plan.CurrentRoot, "candidate-evidence.json");
            WaitForFile(evidencePath, TimeSpan.FromSeconds(5));
            using var evidence = JsonDocument.Parse(File.ReadAllText(evidencePath));
            Expect(!evidence.RootElement.GetProperty("shutdownNonceLeaked").GetBoolean(), "shutdown nonce is scrubbed before Candidate process starts");
            var candidatePid = evidence.RootElement.GetProperty("processId").GetInt32();
            WaitForProcessExit(candidatePid, TimeSpan.FromSeconds(8));
        }
        finally
        {
            fixture.Dispose();
        }
    }

    private static void RunRollbackScenario(string workerExe, string candidatePublishDir)
    {
        var fixture = CreateFixture(candidatePublishDir, "early-exit", "0.5.2");
        try
        {
            var journal = fixture.Journal;
            var prepared = fixture.Prepared;
            Expect(RunWorker(workerExe, null, "plan", prepared.JournalPath, fixture.TransactionsRoot, fixture.DeploymentRoot).ExitCode == 0, "rollback scenario writes canonical worker plan");
            Expect(RunWorker(workerExe, null, "prepare-candidate", prepared.JournalPath, fixture.TransactionsRoot, fixture.DeploymentRoot).ExitCode == 0, "rollback scenario prepares packaged candidate");

            var protocol = new UpdaterWorkerProtocol(journal, fixture.DeploymentRoot);
            var state = journal.Read(prepared.JournalPath);
            var planPath = Path.Combine(Path.GetDirectoryName(prepared.JournalPath)!, "worker-plan.json");
            var plan = protocol.Read(planPath, state);
            var shutdown = IssueShutdownTicket(journal, state);
            var environment = new Dictionary<string, string?>
            {
                [HostShutdownHandoff.NonceEnvironmentVariable] = shutdown.Nonce
            };

            var activation = RunWorker(workerExe, environment, "activate-and-launch", prepared.JournalPath, fixture.TransactionsRoot, fixture.DeploymentRoot, 20000);
            Expect(activation.ExitCode == 2, "early-exit Candidate fails closed through standalone worker");
            Expect(activation.Stderr.Contains("UPDATE_LAUNCH_EARLY_EXIT", StringComparison.Ordinal), "early Candidate failure keeps stable rollback diagnostic code");

            var rolledBack = journal.Read(prepared.JournalPath);
            Expect(string.Equals(rolledBack.State, "rolled-back", StringComparison.Ordinal), "early Candidate exit automatically rolls transaction back");
            Expect(File.Exists(Path.Combine(plan.CurrentRoot, "version.txt")), "rollback restores original Current slot");
            Expect(File.ReadAllText(Path.Combine(plan.CurrentRoot, "version.txt")).Trim() == "0.5.1", "restored Current is the original known-good version");
            Expect(!Directory.Exists(plan.PreviousRoot), "Previous is consumed when rollback restores Current");

            var failedRoot = Path.Combine(plan.CandidateRoot, "FailedCurrent");
            Expect(Directory.Exists(failedRoot), "failed Candidate is quarantined outside Current");
            Expect(File.Exists(Path.Combine(failedRoot, "e2e-mode.txt")), "quarantine preserves failed Candidate diagnostics");
            var evidencePath = Path.Combine(failedRoot, "candidate-evidence.json");
            WaitForFile(evidencePath, TimeSpan.FromSeconds(3));
            using var evidence = JsonDocument.Parse(File.ReadAllText(evidencePath));
            Expect(!evidence.RootElement.GetProperty("shutdownNonceLeaked").GetBoolean(), "rollback Candidate also receives no shutdown nonce");
            Expect(File.Exists(Path.Combine(Path.GetDirectoryName(prepared.JournalPath)!, "shutdown-consumed.json")), "failed launch still consumes one-shot shutdown authorization");
        }
        finally
        {
            fixture.Dispose();
        }
    }

    private static Fixture CreateFixture(string candidatePublishDir, string mode, string targetVersion)
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-packaged-activation-e2e-" + Guid.NewGuid().ToString("N"));
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

    private static HostShutdownHandoff.ShutdownTicket IssueShutdownTicket(UpdateTransactionJournal journal, UpdateTransactionJournal.TransactionState state)
    {
        using var dead = Process.Start(new ProcessStartInfo("cmd.exe", "/d /c exit 0") { UseShellExecute = false, CreateNoWindow = true })
            ?? throw new InvalidOperationException("Could not create completed host process for shutdown handoff E2E.");
        dead.WaitForExit();
        var broker = new HostShutdownHandoff(journal, _ => false, _ => { });
        return broker.Issue(state, dead.Id, TimeSpan.FromSeconds(30));
    }

    private static ProcessResult RunWorker(
        string workerExe,
        IReadOnlyDictionary<string, string?>? environment,
        string command,
        string journal,
        string transactionsRoot,
        string deploymentRoot,
        int timeoutMs = 15000)
    {
        var start = new ProcessStartInfo(workerExe)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        foreach (var arg in new[] { command, "--journal", journal, "--transactions-root", transactionsRoot, "--deployment-root", deploymentRoot })
            start.ArgumentList.Add(arg);
        if (environment is not null)
            foreach (var pair in environment)
                start.Environment[pair.Key] = pair.Value;

        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start standalone updater worker.");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(timeoutMs))
        {
            try { process.Kill(true); } catch { }
            throw new TimeoutException($"Standalone updater worker exceeded {timeoutMs}ms packaged E2E timeout.");
        }
        Task.WaitAll(stdoutTask, stderrTask);
        return new ProcessResult(process.ExitCode, stdoutTask.Result.Trim(), stderrTask.Result.Trim());
    }

    private static UpdateTransactionJournal.TransactionState Begin(UpdateTransactionJournal journal, string root, string packagePath, string targetVersion)
    {
        var bytes = File.ReadAllBytes(packagePath);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var transactionId = targetVersion + "-packaged-e2e-" + Guid.NewGuid().ToString("N");
        var handoff = new UpdateHandoffBroker.HandoffPlan(
            transactionId,
            new Version(0, 5, 1),
            Version.Parse(targetVersion),
            "stable",
            packagePath,
            hash,
            bytes.LongLength,
            "packaged-activation-e2e-2026",
            Path.Combine(root, "installed"),
            Path.Combine(root, transactionId + "-handoff.json"),
            DateTimeOffset.UtcNow,
            "prepared");
        return journal.Begin(handoff);
    }

    private static void CreatePackageFromPublish(string publishDir, string path, string version, string mode)
    {
        var files = Directory.GetFiles(publishDir, "*", SearchOption.AllDirectories)
            .Where(file => !file.EndsWith(".pdb", StringComparison.OrdinalIgnoreCase))
            .ToDictionary(
                file => Path.GetRelativePath(publishDir, file).Replace('\\', '/'),
                File.ReadAllBytes,
                StringComparer.OrdinalIgnoreCase);
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

    private static void WaitForFile(string path, TimeSpan timeout)
    {
        var stopwatch = Stopwatch.StartNew();
        while (!File.Exists(path) && stopwatch.Elapsed < timeout)
            Thread.Sleep(50);
        if (!File.Exists(path))
            throw new TimeoutException($"Expected packaged Candidate evidence was not created: {path}");
    }

    private static void WaitForProcessExit(int pid, TimeSpan timeout)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            if (!process.WaitForExit((int)timeout.TotalMilliseconds))
            {
                try { process.Kill(true); } catch { }
                throw new TimeoutException($"Packaged Candidate process {pid} did not exit in time.");
            }
        }
        catch (ArgumentException)
        {
            // Already exited between evidence read and process lookup.
        }
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
        {
            Root = root;
            TransactionsRoot = transactionsRoot;
            DeploymentRoot = deploymentRoot;
            Journal = journal;
            Prepared = prepared;
        }
        public string Root { get; }
        public string TransactionsRoot { get; }
        public string DeploymentRoot { get; }
        public UpdateTransactionJournal Journal { get; }
        public UpdateTransactionJournal.TransactionState Prepared { get; }
        public void Dispose()
        {
            try { if (Directory.Exists(Root)) Directory.Delete(Root, true); } catch { }
        }
    }
}
