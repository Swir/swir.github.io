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
            var plan = NewPlan(root, installRoot, packagePath, hash, package.Length);

            var journal = new UpdateTransactionJournal(Path.Combine(root, "transactions"));
            var prepared = journal.Begin(plan);
            Expect(File.Exists(prepared.JournalPath), "transaction journal created atomically");
            Expect(prepared.State == "prepared", "transaction starts prepared");
            Expect(journal.Begin(plan).TransactionId == prepared.TransactionId, "begin is idempotent for existing transaction");

            var applying = journal.Transition(prepared, "applying");
            var health = journal.Transition(applying, "awaiting-health-check");
            Expect(journal.RecoverIncomplete().Single().State == "awaiting-health-check", "incomplete transaction is recoverable after restart");

            var now = DateTimeOffset.UtcNow;
            var healthBroker = new UpdateHealthBroker(journal, () => now);
            var challenge = healthBroker.Issue(health, TimeSpan.FromMinutes(2));
            Expect(File.Exists(challenge.HealthPath), "health challenge metadata is persisted atomically");
            Expect(challenge.Token.Length == 64, "health challenge uses a 256-bit random token");
            var healthStatus = healthBroker.GetStatus(health);
            Expect(!healthStatus.Expired && healthStatus.ConfirmedAt is null, "fresh health challenge reports pending state");
            ExpectCode("UPDATE_HEALTH_ALREADY_ISSUED", () => healthBroker.Issue(health, TimeSpan.FromMinutes(2)), "health token cannot be silently rotated for active transaction");
            ExpectCode("UPDATE_HEALTH_TOKEN_INVALID", () => healthBroker.Confirm(health, new string('0', 64), new Version(0, 5, 2)), "wrong health token cannot commit update");
            ExpectCode("UPDATE_HEALTH_VERSION_MISMATCH", () => healthBroker.Confirm(health, challenge.Token, new Version(0, 5, 3)), "wrong running version cannot commit update");
            var committed = healthBroker.Confirm(health, challenge.Token, new Version(0, 5, 2));
            Expect(committed.State == "committed", "valid health proof commits update transaction");
            Expect(journal.RecoverIncomplete().Count == 0, "committed transaction is not recovered as pending");
            ExpectCode("UPDATE_TRANSACTION_TRANSITION_DENIED", () => journal.Transition(committed, "applying"), "terminal committed state cannot be reopened");

            var timeoutPlan = NewPlan(root, installRoot, packagePath, hash, package.Length);
            var timeoutPrepared = journal.Begin(timeoutPlan);
            var timeoutApplying = journal.Transition(timeoutPrepared, "applying");
            var timeoutHealth = journal.Transition(timeoutApplying, "awaiting-health-check");
            var timeoutChallenge = healthBroker.Issue(timeoutHealth, TimeSpan.FromSeconds(5));
            ExpectCode("UPDATE_HEALTH_NOT_EXPIRED", () => healthBroker.EvaluateTimeout(timeoutHealth), "health timeout cannot trigger before deadline");
            now = timeoutChallenge.ExpiresAt.AddSeconds(1);
            var rollbackPendingFromHealth = healthBroker.EvaluateTimeout(timeoutHealth);
            Expect(rollbackPendingFromHealth.State == "rollback-pending", "expired health check schedules rollback");

            var rollbackPlan = NewPlan(root, installRoot, packagePath, hash, package.Length);
            var rollbackPrepared = journal.Begin(rollbackPlan);
            var rollbackApplying = journal.Transition(rollbackPrepared, "applying");
            var rollbackPending = journal.Transition(rollbackApplying, "rollback-pending");
            var rolledBack = journal.Transition(rollbackPending, "rolled-back");
            Expect(rolledBack.State == "rolled-back", "rollback path reaches terminal rolled-back state");

            var failedPlan = NewPlan(root, installRoot, packagePath, hash, package.Length);
            var failedPrepared = journal.Begin(failedPlan);
            ExpectCode("UPDATE_TRANSACTION_FAILURE_CODE_REQUIRED", () => journal.Transition(failedPrepared, "failed"), "failed transition requires diagnostic code");
            var failed = journal.Transition(failedPrepared, "failed", "SELFTEST_FAILURE");
            Expect(failed.FailureCode == "SELFTEST_FAILURE", "failed transaction persists diagnostic code");

            var stalePlan = NewPlan(root, installRoot, packagePath, hash, package.Length);
            var stalePrepared = journal.Begin(stalePlan);
            _ = journal.Transition(stalePrepared, "applying");
            ExpectCode("UPDATE_TRANSACTION_STALE", () => journal.Transition(stalePrepared, "failed", "STALE"), "stale in-memory state cannot overwrite newer journal state");

            var invalidHealthPlan = NewPlan(root, installRoot, packagePath, hash, package.Length);
            var invalidHealthPrepared = journal.Begin(invalidHealthPlan);
            ExpectCode("UPDATE_HEALTH_STATE_INVALID", () => healthBroker.Issue(invalidHealthPrepared), "health challenge cannot be issued before apply reaches health-check state");

            var ttlPlan = NewPlan(root, installRoot, packagePath, hash, package.Length);
            var ttlPrepared = journal.Begin(ttlPlan);
            var ttlApplying = journal.Transition(ttlPrepared, "applying");
            var ttlHealth = journal.Transition(ttlApplying, "awaiting-health-check");
            ExpectCode("UPDATE_HEALTH_TTL_INVALID", () => healthBroker.Issue(ttlHealth, TimeSpan.FromHours(1)), "health challenge rejects excessive TTL");

            ExpectCode("UPDATE_TRANSACTION_PATH_INVALID", () => journal.Read(Path.Combine(root, "outside.json")), "journal read cannot escape transaction sandbox");
            Console.WriteLine($"SWIR Desktop Update Transaction self-tests passed: {_passed}");
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    private static UpdateHandoffBroker.HandoffPlan NewPlan(string root, string installRoot, string packagePath, string hash, long packageLength)
        => new(
            "0.5.2-" + Guid.NewGuid().ToString("N"),
            new Version(0, 5, 1),
            new Version(0, 5, 2),
            "stable",
            packagePath,
            hash,
            packageLength,
            "selftest-2026",
            installRoot,
            Path.Combine(root, "handoff.json"),
            DateTimeOffset.UtcNow,
            "prepared");

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
