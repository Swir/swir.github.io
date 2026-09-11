using System.Security.Cryptography;

namespace Swir.Desktop.Host;

internal static class DesktopStartupRecoverySelfTests
{
    private static int Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-startup-recovery-selftest-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(root);
            PreparedTransactionRemainsPending(root);
            InterruptedApplyingTransactionRollsBack(root);
            MissingHealthChallengeRollsBack(root);
            ActiveTransactionWithoutWorkerPlanFailsClosed(root);
            Console.WriteLine("Desktop startup recovery self-tests passed.");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            return 1;
        }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    private static void PreparedTransactionRemainsPending(string root)
    {
        var fixture = CreateFixture(Path.Combine(root, "prepared"), "2.0.0-prepared");
        var report = new DesktopStartupRecovery(fixture.TransactionsRoot, fixture.DeploymentRoot).RecoverBeforeShellStart();
        Expect(report.IncompleteTransactions == 1, "prepared transaction is discovered");
        Expect(report.ChangedTransactions == 0, "prepared transaction is not changed");
        Expect(report.Items.Single().Action == "no-action-prepared", "prepared transaction is explicitly left pending");
        Expect(fixture.Journal.Read(fixture.State.JournalPath).State == "prepared", "prepared state remains canonical");
    }

    private static void InterruptedApplyingTransactionRollsBack(string root)
    {
        var fixture = CreateFixture(Path.Combine(root, "applying"), "2.0.0-applying");
        Directory.CreateDirectory(fixture.Plan.PreviousRoot);
        File.WriteAllText(Path.Combine(fixture.Plan.PreviousRoot, "known-good.txt"), "known-good");
        fixture.Journal.Transition(fixture.State, "applying");

        var report = new DesktopStartupRecovery(fixture.TransactionsRoot, fixture.DeploymentRoot).RecoverBeforeShellStart();
        var state = fixture.Journal.Read(fixture.State.JournalPath);
        Expect(report.ChangedTransactions == 1, "interrupted applying transaction is changed by recovery");
        Expect(state.State == "rolled-back", "interrupted applying transaction reaches rolled-back");
        Expect(File.Exists(Path.Combine(fixture.Plan.CurrentRoot, "known-good.txt")), "known-good Previous becomes Current again");
    }

    private static void MissingHealthChallengeRollsBack(string root)
    {
        var fixture = CreateFixture(Path.Combine(root, "health-missing"), "2.0.0-health");
        Directory.CreateDirectory(fixture.Plan.PreviousRoot);
        File.WriteAllText(Path.Combine(fixture.Plan.PreviousRoot, "known-good.txt"), "known-good");
        Directory.CreateDirectory(fixture.Plan.CurrentRoot);
        File.WriteAllText(Path.Combine(fixture.Plan.CurrentRoot, "candidate.txt"), "candidate");
        var applying = fixture.Journal.Transition(fixture.State, "applying");
        fixture.Journal.Transition(applying, "awaiting-health-check");

        var report = new DesktopStartupRecovery(fixture.TransactionsRoot, fixture.DeploymentRoot).RecoverBeforeShellStart();
        var state = fixture.Journal.Read(fixture.State.JournalPath);
        Expect(report.Items.Single().Action == "missing-health-challenge-rolled-back", "missing health metadata forces rollback");
        Expect(state.State == "rolled-back", "missing health transaction reaches rolled-back");
        Expect(File.Exists(Path.Combine(fixture.Plan.CurrentRoot, "known-good.txt")), "known-good deployment restored after missing health challenge");
        Expect(File.Exists(Path.Combine(fixture.Plan.CandidateRoot, "FailedCurrent", "candidate.txt")), "failed candidate is quarantined");
    }

    private static void ActiveTransactionWithoutWorkerPlanFailsClosed(string root)
    {
        var fixture = CreateFixture(Path.Combine(root, "missing-plan"), "2.0.0-missing-plan", prepareWorkerPlan: false);
        fixture.Journal.Transition(fixture.State, "applying");
        try
        {
            _ = new DesktopStartupRecovery(fixture.TransactionsRoot, fixture.DeploymentRoot).RecoverBeforeShellStart();
            throw new Exception("Expected missing worker plan to block startup recovery.");
        }
        catch (UpdateSecurityException ex)
        {
            Expect(ex.Code == "UPDATE_STARTUP_RECOVERY_PLAN_MISSING", "missing active worker plan fails closed with stable error code");
        }
    }

    private static Fixture CreateFixture(string root, string transactionId, bool prepareWorkerPlan = true)
    {
        var installRoot = Path.Combine(root, "installed");
        var transactionsRoot = Path.Combine(root, "transactions");
        var deploymentRoot = Path.Combine(root, "deployment");
        var packagePath = Path.Combine(root, "package.bin");
        Directory.CreateDirectory(installRoot);
        Directory.CreateDirectory(transactionsRoot);
        Directory.CreateDirectory(deploymentRoot);
        Directory.CreateDirectory(Path.GetDirectoryName(packagePath)!);
        File.WriteAllText(packagePath, "verified-package");
        var bytes = File.ReadAllBytes(packagePath);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var journal = new UpdateTransactionJournal(transactionsRoot);
        var handoff = new UpdateHandoffBroker.HandoffPlan(
            transactionId,
            new Version(1, 0, 0),
            new Version(2, 0, 0),
            "stable",
            packagePath,
            hash,
            bytes.LongLength,
            "test-key",
            installRoot,
            Path.Combine(root, "handoff.json"),
            DateTimeOffset.UtcNow,
            "prepared");
        var state = journal.Begin(handoff);
        var protocol = new UpdaterWorkerProtocol(journal, deploymentRoot);
        var plan = prepareWorkerPlan
            ? protocol.Prepare(state)
            : new UpdaterWorkerProtocol.WorkerPlan(
                transactionId,
                state.CurrentVersion,
                state.TargetVersion,
                packagePath,
                hash,
                bytes.LongLength,
                installRoot,
                Path.Combine(deploymentRoot, "Current"),
                Path.Combine(deploymentRoot, "Previous"),
                Path.Combine(deploymentRoot, "Candidate", transactionId),
                "planned",
                DateTimeOffset.UtcNow,
                Path.Combine(Path.GetDirectoryName(state.JournalPath)!, "worker-plan.json"));
        return new Fixture(transactionsRoot, deploymentRoot, journal, state, plan);
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition) throw new Exception("Self-test failed: " + message);
    }

    private sealed record Fixture(
        string TransactionsRoot,
        string DeploymentRoot,
        UpdateTransactionJournal Journal,
        UpdateTransactionJournal.TransactionState State,
        UpdaterWorkerProtocol.WorkerPlan Plan);
}
