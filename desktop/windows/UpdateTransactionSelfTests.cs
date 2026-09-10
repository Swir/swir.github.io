using System.Security.Cryptography;
using System.Text;
using Swir.Desktop.Host;

internal static class UpdateTransactionSelfTests
{
    private static int _passed;

    private static void Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-transaction-selftest-" + Guid.NewGuid().ToString("N"));
        var installRoot = Path.Combine(root, "install");
        var packagePath = Path.Combine(root, "package.bin");
        try
        {
            Directory.CreateDirectory(installRoot);
            var package = Encoding.UTF8.GetBytes("SWIR-TRANSACTION-TEST");
            File.WriteAllBytes(packagePath, package);
            var hash = Convert.ToHexString(SHA256.HashData(package)).ToLowerInvariant();
            var plan = new UpdateHandoffBroker.HandoffPlan(
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

            var journal = new UpdateTransactionJournal(Path.Combine(root, "transactions"));
            var prepared = journal.Begin(plan);
            Expect(File.Exists(prepared.JournalPath), "transaction journal created atomically");
            Expect(prepared.State == "prepared", "transaction starts prepared");
            Expect(journal.Begin(plan).TransactionId == prepared.TransactionId, "begin is idempotent for existing transaction");

            var applying = journal.Transition(prepared, "applying");
            var health = journal.Transition(applying, "awaiting-health-check");
            Expect(journal.RecoverIncomplete().Single().State == "awaiting-health-check", "incomplete transaction is recoverable after restart");
            var committed = journal.Transition(health, "committed");
            Expect(journal.RecoverIncomplete().Count == 0, "committed transaction is not recovered as pending");
            ExpectCode("UPDATE_TRANSACTION_TRANSITION_DENIED", () => journal.Transition(committed, "applying"), "terminal committed state cannot be reopened");

            var rollbackPlan = plan with { TransactionId = "0.5.2-" + Guid.NewGuid().ToString("N") };
            var rollbackPrepared = journal.Begin(rollbackPlan);
            var rollbackApplying = journal.Transition(rollbackPrepared, "applying");
            var rollbackPending = journal.Transition(rollbackApplying, "rollback-pending");
            var rolledBack = journal.Transition(rollbackPending, "rolled-back");
            Expect(rolledBack.State == "rolled-back", "rollback path reaches terminal rolled-back state");

            var failedPlan = plan with { TransactionId = "0.5.2-" + Guid.NewGuid().ToString("N") };
            var failedPrepared = journal.Begin(failedPlan);
            ExpectCode("UPDATE_TRANSACTION_FAILURE_CODE_REQUIRED", () => journal.Transition(failedPrepared, "failed"), "failed transition requires diagnostic code");
            var failed = journal.Transition(failedPrepared, "failed", "SELFTEST_FAILURE");
            Expect(failed.FailureCode == "SELFTEST_FAILURE", "failed transaction persists diagnostic code");

            var stalePlan = plan with { TransactionId = "0.5.2-" + Guid.NewGuid().ToString("N") };
            var stalePrepared = journal.Begin(stalePlan);
            _ = journal.Transition(stalePrepared, "applying");
            ExpectCode("UPDATE_TRANSACTION_STALE", () => journal.Transition(stalePrepared, "failed", "STALE"), "stale in-memory state cannot overwrite newer journal state");

            ExpectCode("UPDATE_TRANSACTION_PATH_INVALID", () => journal.Read(Path.Combine(root, "outside.json")), "journal read cannot escape transaction sandbox");
            Console.WriteLine($"SWIR Desktop Update Transaction self-tests passed: {_passed}");
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
