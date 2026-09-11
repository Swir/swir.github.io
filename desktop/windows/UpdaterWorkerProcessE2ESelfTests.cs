using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Swir.Desktop.Host;

internal static class UpdaterWorkerProcessE2ESelfTests
{
    private static int _passed;

    private static int Main(string[] args)
    {
        if (args.Length != 1)
        {
            Console.Error.WriteLine("Usage: SWIR.Desktop.UpdaterWorker.ProcessE2E.SelfTests <path-to-updater-worker-exe>");
            return 2;
        }

        var workerExe = Path.GetFullPath(args[0]);
        if (!File.Exists(workerExe))
        {
            Console.Error.WriteLine($"Updater worker executable not found: {workerExe}");
            return 2;
        }

        var root = Path.Combine(Path.GetTempPath(), "swir-updater-process-e2e-" + Guid.NewGuid().ToString("N"));
        var installRoot = Path.Combine(root, "installed");
        var transactionsRoot = Path.Combine(root, "transactions");
        var deploymentRoot = Path.Combine(root, "deployment");

        try
        {
            Directory.CreateDirectory(installRoot);
            var packagePath = Path.Combine(root, "package.zip");
            CreatePackage(packagePath, "0.5.2", "SWIR.Desktop.Host.exe", new Dictionary<string, byte[]>
            {
                ["SWIR.Desktop.Host.exe"] = Encoding.UTF8.GetBytes("HOST-0.5.2-PROCESS-E2E"),
                ["assets/runtime.txt"] = Encoding.UTF8.GetBytes("RUNTIME-PROCESS-E2E")
            });

            var journal = new UpdateTransactionJournal(transactionsRoot);
            var prepared = Begin(journal, root, installRoot, packagePath, "0.5.2");

            var plan = Run(workerExe, null, "plan", prepared.JournalPath, transactionsRoot, deploymentRoot);
            Expect(plan.ExitCode == 0, "standalone worker accepts canonical plan request");
            using (var json = JsonDocument.Parse(plan.Stdout))
            {
                Expect(json.RootElement.GetProperty("schema").GetString() == UpdaterWorkerProtocol.WorkerPlanSchema, "plan output uses versioned worker schema");
                Expect(json.RootElement.GetProperty("executableActionsEnabled").GetBoolean() == false, "plan command remains non-executable");
            }

            var transactionDirectory = Path.GetDirectoryName(prepared.JournalPath)!;
            var workerPlanPath = Path.Combine(transactionDirectory, "worker-plan.json");
            Expect(File.Exists(workerPlanPath), "standalone worker persists canonical worker-plan.json");
            Expect(!Directory.Exists(Path.Combine(deploymentRoot, "Current")), "plan process cannot mutate Current slot");
            Expect(!Directory.Exists(Path.Combine(deploymentRoot, "Previous")), "plan process cannot mutate Previous slot");

            var candidate = Run(workerExe, null, "prepare-candidate", prepared.JournalPath, transactionsRoot, deploymentRoot);
            Expect(candidate.ExitCode == 0, "standalone worker prepares candidate in a separate process");
            using (var json = JsonDocument.Parse(candidate.Stdout))
            {
                Expect(json.RootElement.GetProperty("schema").GetString() == CandidatePackagePreparer.CandidateStateSchema, "candidate output uses versioned candidate schema");
                Expect(json.RootElement.GetProperty("executableActionsEnabled").GetBoolean() == false, "candidate preparation remains non-executable");
            }

            var protocol = new UpdaterWorkerProtocol(journal, deploymentRoot);
            var persistedPlan = protocol.Read(workerPlanPath, journal.Read(prepared.JournalPath));
            var candidateStatePath = Path.Combine(persistedPlan.CandidateRoot, "candidate-state.json");
            var verified = new CandidatePackagePreparer().ReadAndVerify(persistedPlan, candidateStatePath);
            Expect(verified.FileCount == 2, "host process independently re-verifies worker-prepared candidate");
            Expect(!Directory.Exists(persistedPlan.CurrentRoot) && !Directory.Exists(persistedPlan.PreviousRoot), "prepare-candidate process leaves deployment slots untouched");

            var escapedRoot = Path.Combine(root, "escaped-deployment");
            var rejected = Run(workerExe, null, "plan", prepared.JournalPath, transactionsRoot, escapedRoot);
            Expect(rejected.ExitCode == 2, "worker rejects a deployment root that disagrees with persisted canonical plan");
            Expect(rejected.Stderr.Contains("UPDATE_WORKER_PLAN_INVALID", StringComparison.Ordinal), "root mismatch fails closed with stable security code");

            var invalidArgs = RunRaw(workerExe, null, new[] { "plan", "--journal", prepared.JournalPath });
            Expect(invalidArgs.ExitCode == 2, "worker rejects incomplete CLI contract");
            Expect(invalidArgs.Stderr.Contains("UPDATE_WORKER_ARGS_INVALID", StringComparison.Ordinal), "invalid CLI fails with stable security code");

            var leakedEnvironment = new Dictionary<string, string?>
            {
                [HostShutdownHandoff.NonceEnvironmentVariable] = "process-e2e-secret-that-must-not-be-used"
            };
            var readonlyWithNonce = Run(workerExe, leakedEnvironment, "plan", prepared.JournalPath, transactionsRoot, deploymentRoot);
            Expect(readonlyWithNonce.ExitCode == 0, "read-only worker command is unaffected by unrelated shutdown nonce");

            Console.WriteLine($"SWIR standalone Updater Worker process E2E self-tests passed: {_passed}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("SWIR standalone Updater Worker process E2E self-tests: FAIL");
            Console.Error.WriteLine(ex);
            return 1;
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    private static ProcessResult Run(string workerExe, IReadOnlyDictionary<string, string?>? environment, string command, string journal, string transactionsRoot, string deploymentRoot)
        => RunRaw(workerExe, environment, new[]
        {
            command,
            "--journal", journal,
            "--transactions-root", transactionsRoot,
            "--deployment-root", deploymentRoot
        });

    private static ProcessResult RunRaw(string workerExe, IReadOnlyDictionary<string, string?>? environment, IEnumerable<string> args)
    {
        var start = new ProcessStartInfo(workerExe)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        if (environment is not null)
            foreach (var pair in environment)
                start.Environment[pair.Key] = pair.Value;

        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start standalone updater worker.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        if (!process.WaitForExit(15000))
        {
            try { process.Kill(true); } catch { }
            throw new TimeoutException("Standalone updater worker exceeded 15 second E2E timeout.");
        }
        return new ProcessResult(process.ExitCode, stdout.Trim(), stderr.Trim());
    }

    private static UpdateTransactionJournal.TransactionState Begin(UpdateTransactionJournal journal, string root, string installRoot, string packagePath, string targetVersion)
    {
        var bytes = File.ReadAllBytes(packagePath);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var transactionId = targetVersion + "-process-e2e-" + Guid.NewGuid().ToString("N");
        var handoff = new UpdateHandoffBroker.HandoffPlan(
            transactionId,
            new Version(0, 5, 1),
            Version.Parse(targetVersion),
            "stable",
            packagePath,
            hash,
            bytes.LongLength,
            "process-e2e-2026",
            installRoot,
            Path.Combine(root, transactionId + "-handoff.json"),
            DateTimeOffset.UtcNow,
            "prepared");
        return journal.Begin(handoff);
    }

    private static void CreatePackage(string path, string version, string entryPoint, Dictionary<string, byte[]> files)
    {
        using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
        var manifestFiles = files.Select(pair => new CandidatePackagePreparer.PackageFile(
            pair.Key,
            Convert.ToHexString(SHA256.HashData(pair.Value)).ToLowerInvariant(),
            pair.Value.LongLength)).ToList();
        var manifest = new CandidatePackagePreparer.PackageManifest(
            CandidatePackagePreparer.PackageManifestSchema,
            version,
            entryPoint,
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

    private static void Expect(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException("FAILED: " + name);
        _passed++;
        Console.WriteLine("PASS: " + name);
    }

    private sealed record ProcessResult(int ExitCode, string Stdout, string Stderr);
}