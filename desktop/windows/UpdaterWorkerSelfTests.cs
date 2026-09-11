using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Swir.Desktop.Host;

internal static class UpdaterWorkerSelfTests
{
    private static int _passed;

    private static void Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-updater-worker-selftest-" + Guid.NewGuid().ToString("N"));
        var installRoot = Path.Combine(root, "installed");
        var transactionsRoot = Path.Combine(root, "transactions");
        var deploymentRoot = Path.Combine(root, "deployment");
        try
        {
            Directory.CreateDirectory(installRoot);
            var packagePath = Path.Combine(root, "package.zip");
            CreatePackage(packagePath, "0.5.2", "SWIR.Desktop.Host.exe", new Dictionary<string, byte[]>
            {
                ["SWIR.Desktop.Host.exe"] = Encoding.UTF8.GetBytes("HOST-0.5.2"),
                ["assets/runtime.txt"] = Encoding.UTF8.GetBytes("RUNTIME-ASSET")
            });

            var journal = new UpdateTransactionJournal(transactionsRoot);
            var protocol = new UpdaterWorkerProtocol(journal, deploymentRoot);
            var prepared = Begin(journal, root, installRoot, packagePath, "0.5.2");
            var workerPlan = protocol.Prepare(prepared);

            Expect(workerPlan.State == "planned", "worker creates a non-executing planned state");
            Expect(File.Exists(workerPlan.PlanPath), "worker plan is persisted beside transaction journal");
            Expect(Directory.Exists(workerPlan.CandidateRoot), "transaction-specific candidate directory is created");
            Expect(!Directory.Exists(workerPlan.CurrentRoot), "planning does not create or mutate Current installation slot");
            Expect(!Directory.Exists(workerPlan.PreviousRoot), "planning does not create or mutate Previous installation slot");
            Expect(workerPlan.CandidateRoot.StartsWith(Path.GetFullPath(deploymentRoot) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase), "candidate remains inside deployment sandbox");
            Expect(protocol.Prepare(prepared).PlanPath == workerPlan.PlanPath, "worker planning is idempotent for a transaction");

            var candidatePreparer = new CandidatePackagePreparer();
            var candidate = candidatePreparer.Prepare(workerPlan);
            Expect(candidate.Schema == CandidatePackagePreparer.CandidateStateSchema, "candidate state uses versioned schema");
            Expect(candidate.FileCount == 2, "candidate records manifested file count");
            Expect(File.Exists(Path.Combine(candidate.PayloadRoot, "SWIR.Desktop.Host.exe")), "candidate extracts declared host entry point");
            Expect(File.Exists(Path.Combine(candidate.PayloadRoot, "assets", "runtime.txt")), "candidate extracts nested manifested assets");
            Expect(!Directory.Exists(workerPlan.CurrentRoot) && !Directory.Exists(workerPlan.PreviousRoot), "candidate preparation cannot mutate active or rollback slots");
            Expect(candidatePreparer.Prepare(workerPlan).StatePath == candidate.StatePath, "candidate preparation is idempotent and re-verifies payload");

            File.WriteAllText(Path.Combine(candidate.PayloadRoot, "assets", "runtime.txt"), "TAMPERED");
            ExpectCode("UPDATE_CANDIDATE_PAYLOAD_INVALID", () => candidatePreparer.ReadAndVerify(workerPlan, candidate.StatePath), "candidate payload tampering is detected before activation");

            var applying = journal.Transition(prepared, "applying");
            ExpectCode("UPDATE_WORKER_STATE_INVALID", () => protocol.Prepare(applying), "worker refuses planning after transaction leaves prepared state");

            var json = File.ReadAllText(workerPlan.PlanPath);
            using (var document = JsonDocument.Parse(json))
            {
                var map = document.RootElement.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.Clone(), StringComparer.Ordinal);
                var tampered = new Dictionary<string, object?>();
                foreach (var pair in map)
                    tampered[pair.Key] = pair.Key == "CandidateRoot" ? Path.Combine(root, "escaped") : JsonSerializer.Deserialize<object>(pair.Value.GetRawText());
                File.WriteAllText(workerPlan.PlanPath, JsonSerializer.Serialize(tampered));
            }
            ExpectCode("UPDATE_WORKER_PLAN_INVALID", () => protocol.Read(workerPlan.PlanPath, applying), "tampered worker path cannot escape deployment contract");

            var missingPackage = Path.Combine(root, "missing.zip");
            CreatePackage(missingPackage, "0.5.2", "SWIR.Desktop.Host.exe", new Dictionary<string, byte[]> { ["SWIR.Desktop.Host.exe"] = Encoding.UTF8.GetBytes("HOST") });
            var missingPrepared = Begin(journal, root, installRoot, missingPackage, "0.5.2");
            File.Delete(missingPackage);
            ExpectCode("UPDATE_WORKER_PACKAGE_INVALID", () => protocol.Prepare(missingPrepared), "worker refuses missing staged package");

            var traversalPackage = Path.Combine(root, "traversal.zip");
            CreatePackage(traversalPackage, "0.5.2", "../evil.exe", new Dictionary<string, byte[]> { ["../evil.exe"] = Encoding.UTF8.GetBytes("EVIL") });
            var traversalPrepared = Begin(journal, root, installRoot, traversalPackage, "0.5.2");
            var traversalPlan = protocol.Prepare(traversalPrepared);
            ExpectCode("UPDATE_CANDIDATE_PATH_INVALID", () => candidatePreparer.Prepare(traversalPlan), "Zip Slip traversal is rejected before extraction");
            Expect(!File.Exists(Path.Combine(deploymentRoot, "evil.exe")) && !File.Exists(Path.Combine(root, "evil.exe")), "rejected traversal creates no escaped file");

            var wrongVersionPackage = Path.Combine(root, "wrong-version.zip");
            CreatePackage(wrongVersionPackage, "0.5.3", "SWIR.Desktop.Host.exe", new Dictionary<string, byte[]> { ["SWIR.Desktop.Host.exe"] = Encoding.UTF8.GetBytes("HOST") });
            var wrongVersionPrepared = Begin(journal, root, installRoot, wrongVersionPackage, "0.5.2");
            var wrongVersionPlan = protocol.Prepare(wrongVersionPrepared);
            ExpectCode("UPDATE_CANDIDATE_MANIFEST_INVALID", () => candidatePreparer.Prepare(wrongVersionPlan), "candidate package version must match signed target version");

            RunActivationTests(root, installRoot, journal, protocol, candidatePreparer);

            ExpectCode("UPDATE_WORKER_ROOT_INVALID", () => _ = new UpdaterWorkerProtocol(journal, " "), "worker requires explicit deployment root");
            Console.WriteLine($"SWIR Desktop Updater Worker self-tests passed: {_passed}");
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    private static void RunActivationTests(string root, string installRoot, UpdateTransactionJournal journal, UpdaterWorkerProtocol protocol, CandidatePackagePreparer preparer)
    {
        var deploymentRoot = Path.GetDirectoryName(protocol.Prepare(Begin(journal, root, installRoot, CreateActivationPackage(root, "activation-success.zip", "0.5.4"), "0.5.4")).CurrentRoot)!;
        ResetDeployment(deploymentRoot, "OLD-0.5.1");

        var successPackage = CreateActivationPackage(root, "activation-success-2.zip", "0.5.5");
        var successPrepared = Begin(journal, root, installRoot, successPackage, "0.5.5");
        var successPlan = protocol.Prepare(successPrepared);
        var successCandidate = preparer.Prepare(successPlan);
        var activator = new DeploymentSlotActivator(journal, preparer);
        var activation = activator.Activate(successPlan, successCandidate);
        Expect(activation.Phase == "awaiting-health-check", "slot activation reaches awaiting-health-check only after both atomic moves");
        Expect(journal.Read(successPrepared.JournalPath).State == "awaiting-health-check", "transaction journal follows successful slot activation");
        Expect(File.ReadAllText(Path.Combine(successPlan.PreviousRoot, "version.txt")) == "OLD-0.5.1", "Current is preserved as Previous before candidate promotion");
        Expect(File.Exists(Path.Combine(successPlan.CurrentRoot, "SWIR.Desktop.Host.exe")), "candidate payload is promoted into Current");
        Expect(activator.Read(successPlan).Phase == "awaiting-health-check", "activation checkpoint is persisted and readable");

        var rollbackPending = journal.Transition(journal.Read(successPrepared.JournalPath), "rollback-pending");
        var rolledBack = activator.Rollback(successPlan);
        Expect(rollbackPending.State == "rollback-pending" && rolledBack.State == "rolled-back", "explicit rollback completes journal state transition");
        Expect(File.ReadAllText(Path.Combine(successPlan.CurrentRoot, "version.txt")) == "OLD-0.5.1", "rollback restores Previous as Current");
        Expect(!Directory.Exists(successPlan.PreviousRoot), "rollback consumes Previous only after restoration");
        Expect(Directory.Exists(Path.Combine(successPlan.CandidateRoot, "FailedCurrent")), "failed candidate is quarantined instead of deleted during rollback");

        ResetDeployment(deploymentRoot, "OLD-AFTER-BACKUP");
        var crash1Package = CreateActivationPackage(root, "activation-crash-backup.zip", "0.5.6");
        var crash1Prepared = Begin(journal, root, installRoot, crash1Package, "0.5.6");
        var crash1Plan = protocol.Prepare(crash1Prepared);
        var crash1Candidate = preparer.Prepare(crash1Plan);
        var crashAfterBackup = new DeploymentSlotActivator(journal, preparer, point => { if (point == "after-current-backup") throw new SimulatedCrashException(); });
        ExpectThrows<SimulatedCrashException>(() => crashAfterBackup.Activate(crash1Plan, crash1Candidate), "failure injection interrupts activation after Current backup");
        Expect(journal.Read(crash1Prepared.JournalPath).State == "applying", "interrupted activation remains recoverable in applying state");
        var recovered1 = new DeploymentSlotActivator(journal, preparer).RecoverApplying(crash1Plan);
        Expect(recovered1.State == "rolled-back", "recovery rolls back interrupted activation after Current backup");
        Expect(File.ReadAllText(Path.Combine(crash1Plan.CurrentRoot, "version.txt")) == "OLD-AFTER-BACKUP", "recovery restores original Current after backup-stage crash");

        ResetDeployment(deploymentRoot, "OLD-AFTER-PROMOTE");
        var crash2Package = CreateActivationPackage(root, "activation-crash-promote.zip", "0.5.7");
        var crash2Prepared = Begin(journal, root, installRoot, crash2Package, "0.5.7");
        var crash2Plan = protocol.Prepare(crash2Prepared);
        var crash2Candidate = preparer.Prepare(crash2Plan);
        var crashAfterPromote = new DeploymentSlotActivator(journal, preparer, point => { if (point == "after-candidate-promote") throw new SimulatedCrashException(); });
        ExpectThrows<SimulatedCrashException>(() => crashAfterPromote.Activate(crash2Plan, crash2Candidate), "failure injection interrupts activation after candidate promotion");
        var recovered2 = new DeploymentSlotActivator(journal, preparer).RecoverApplying(crash2Plan);
        Expect(recovered2.State == "rolled-back", "recovery prefers rollback over forward resume after ambiguous promotion crash");
        Expect(File.ReadAllText(Path.Combine(crash2Plan.CurrentRoot, "version.txt")) == "OLD-AFTER-PROMOTE", "ambiguous promotion crash restores known-good Previous slot");
        Expect(Directory.Exists(Path.Combine(crash2Plan.CandidateRoot, "AbandonedCurrent")), "ambiguous promoted candidate is quarantined for diagnostics");
    }

    private static string CreateActivationPackage(string root, string fileName, string version)
    {
        var path = Path.Combine(root, fileName);
        CreatePackage(path, version, "SWIR.Desktop.Host.exe", new Dictionary<string, byte[]>
        {
            ["SWIR.Desktop.Host.exe"] = Encoding.UTF8.GetBytes("HOST-" + version),
            ["assets/runtime.txt"] = Encoding.UTF8.GetBytes("RUNTIME-" + version)
        });
        return path;
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

    private static UpdateTransactionJournal.TransactionState Begin(UpdateTransactionJournal journal, string root, string installRoot, string packagePath, string targetVersion)
    {
        var bytes = File.ReadAllBytes(packagePath);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var transactionId = targetVersion + "-" + Guid.NewGuid().ToString("N");
        var handoff = new UpdateHandoffBroker.HandoffPlan(
            transactionId,
            new Version(0, 5, 1),
            Version.Parse(targetVersion),
            "stable",
            packagePath,
            hash,
            bytes.LongLength,
            "selftest-2026",
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

    private static void ExpectThrows<T>(Action action, string name) where T : Exception
    {
        try { action(); }
        catch (T)
        {
            Expect(true, name);
            return;
        }
        throw new Exception($"FAILED: {name}; expected {typeof(T).Name}");
    }

    private sealed class SimulatedCrashException : Exception { }
}
