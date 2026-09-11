using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Swir.Desktop.Host;

internal static class UpdateActivationCoordinatorSelfTests
{
    private static int _passed;

    private static void Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-activation-coordinator-selftest-" + Guid.NewGuid().ToString("N"));
        try
        {
            var installRoot = Path.Combine(root, "installed");
            var transactionsRoot = Path.Combine(root, "transactions");
            var deploymentRoot = Path.Combine(root, "deployment");
            Directory.CreateDirectory(installRoot);

            var journal = new UpdateTransactionJournal(transactionsRoot);
            var protocol = new UpdaterWorkerProtocol(journal, deploymentRoot);
            var preparer = new CandidatePackagePreparer();

            ResetCurrent(deploymentRoot, "KNOWN-GOOD");
            var successPackage = CreatePackage(root, "success.zip", "0.6.0");
            var successPrepared = Begin(journal, root, installRoot, successPackage, "0.6.0");
            var successPlan = protocol.Prepare(successPrepared);
            var successCandidate = preparer.Prepare(successPlan);
            var successActivator = new DeploymentSlotActivator(journal, preparer);
            var successHealth = new UpdateHealthBroker(journal);
            var successCoordinator = new UpdateActivationCoordinator(journal, successActivator, successHealth);
            var ready = successCoordinator.ActivateAndIssueHealth(successPlan, successCandidate, TimeSpan.FromMinutes(2));

            Expect(ready.Activation.Phase == "awaiting-health-check", "guarded activation reaches awaiting-health-check");
            Expect(ready.HealthChallenge.Token.Length == 64, "guarded activation returns an in-memory 256-bit health token");
            Expect(File.Exists(ready.HealthChallenge.HealthPath), "health metadata is persisted before guarded activation returns");
            Expect(journal.Read(successPrepared.JournalPath).State == "awaiting-health-check", "journal remains pending until candidate confirms health");
            Expect(File.ReadAllText(Path.Combine(successPlan.PreviousRoot, "version.txt")) == "KNOWN-GOOD", "known-good Current is preserved as Previous");
            Expect(File.Exists(Path.Combine(successPlan.CurrentRoot, "SWIR.Desktop.Host.exe")), "verified candidate is promoted to Current");

            var committed = successHealth.Confirm(
                journal.Read(successPrepared.JournalPath),
                ready.HealthChallenge.Token,
                new Version(0, 6, 0));
            Expect(committed.State == "committed", "candidate can commit using coordinator-issued health token");

            ResetCurrent(deploymentRoot, "KNOWN-GOOD-ROLLBACK");
            var failurePackage = CreatePackage(root, "failure.zip", "0.6.1");
            var failurePrepared = Begin(journal, root, installRoot, failurePackage, "0.6.1");
            var failurePlan = protocol.Prepare(failurePrepared);
            var failureCandidate = preparer.Prepare(failurePlan);
            var failureActivator = new DeploymentSlotActivator(journal, preparer);
            var failureHealth = new UpdateHealthBroker(journal);
            var failureCoordinator = new UpdateActivationCoordinator(journal, failureActivator, failureHealth);

            ExpectCode(
                "UPDATE_ACTIVATION_HEALTH_FAILED",
                () => failureCoordinator.ActivateAndIssueHealth(failurePlan, failureCandidate, TimeSpan.FromSeconds(1)),
                "invalid health TTL after promotion triggers guarded rollback");
            Expect(journal.Read(failurePrepared.JournalPath).State == "rolled-back", "health challenge failure completes rollback transaction");
            Expect(File.ReadAllText(Path.Combine(failurePlan.CurrentRoot, "version.txt")) == "KNOWN-GOOD-ROLLBACK", "health challenge failure restores known-good Current");
            Expect(!Directory.Exists(failurePlan.PreviousRoot), "rollback consumes Previous only after restoration");
            Expect(Directory.Exists(Path.Combine(failurePlan.CandidateRoot, "FailedCurrent")), "failed promoted candidate is quarantined for diagnostics");

            Console.WriteLine($"SWIR Desktop activation coordinator self-tests passed: {_passed}");
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    private static UpdateTransactionJournal.TransactionState Begin(
        UpdateTransactionJournal journal,
        string root,
        string installRoot,
        string packagePath,
        string targetVersion)
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

    private static string CreatePackage(string root, string fileName, string version)
    {
        var path = Path.Combine(root, fileName);
        var files = new Dictionary<string, byte[]>
        {
            ["SWIR.Desktop.Host.exe"] = Encoding.UTF8.GetBytes("HOST-" + version),
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
        return path;
    }

    private static void ResetCurrent(string deploymentRoot, string marker)
    {
        if (Directory.Exists(deploymentRoot)) Directory.Delete(deploymentRoot, true);
        var current = Path.Combine(deploymentRoot, "Current");
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
}
