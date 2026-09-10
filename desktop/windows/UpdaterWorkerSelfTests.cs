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
        var packagePath = Path.Combine(root, "package.bin");
        var transactionsRoot = Path.Combine(root, "transactions");
        var deploymentRoot = Path.Combine(root, "deployment");
        try
        {
            Directory.CreateDirectory(installRoot);
            var package = Encoding.UTF8.GetBytes("SWIR-UPDATER-WORKER-TEST");
            File.WriteAllBytes(packagePath, package);
            var hash = Convert.ToHexString(SHA256.HashData(package)).ToLowerInvariant();
            var handoff = new UpdateHandoffBroker.HandoffPlan(
                "0.5.2-" + Guid.NewGuid().ToString("N"),
                new Version(0, 5, 1),
                new Version(0, 5, 2),
                "stable",
                packagePath,
                hash,
                package.Length,
                "selftest-2026",
                installRoot,
                Path.Combine(root, "handoff.json"),
                DateTimeOffset.UtcNow,
                "prepared");

            var journal = new UpdateTransactionJournal(transactionsRoot);
            var prepared = journal.Begin(handoff);
            var protocol = new UpdaterWorkerProtocol(journal, deploymentRoot);
            var workerPlan = protocol.Prepare(prepared);

            Expect(workerPlan.State == "planned", "worker creates a non-executing planned state");
            Expect(File.Exists(workerPlan.PlanPath), "worker plan is persisted beside transaction journal");
            Expect(Directory.Exists(workerPlan.CandidateRoot), "transaction-specific candidate directory is created");
            Expect(!Directory.Exists(workerPlan.CurrentRoot), "planning does not create or mutate Current installation slot");
            Expect(!Directory.Exists(workerPlan.PreviousRoot), "planning does not create or mutate Previous installation slot");
            Expect(workerPlan.CandidateRoot.StartsWith(Path.GetFullPath(deploymentRoot) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase), "candidate remains inside deployment sandbox");
            Expect(protocol.Prepare(prepared).PlanPath == workerPlan.PlanPath, "worker planning is idempotent for a transaction");

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

            var secondHandoff = handoff with { TransactionId = "0.5.2-" + Guid.NewGuid().ToString("N"), PlanPath = Path.Combine(root, "handoff-2.json") };
            var secondPrepared = journal.Begin(secondHandoff);
            File.Delete(packagePath);
            ExpectCode("UPDATE_WORKER_PACKAGE_INVALID", () => protocol.Prepare(secondPrepared), "worker refuses missing staged package");

            ExpectCode("UPDATE_WORKER_ROOT_INVALID", () => _ = new UpdaterWorkerProtocol(journal, " "), "worker requires explicit deployment root");
            Console.WriteLine($"SWIR Desktop Updater Worker self-tests passed: {_passed}");
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
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
