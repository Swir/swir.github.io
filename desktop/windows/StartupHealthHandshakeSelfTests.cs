using System.Security.Cryptography;
using Swir.Desktop.Host;

internal static class StartupHealthHandshakeSelfTests
{
    private static int _passed;

    private static void Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-startup-health-selftest-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(root);
            var transactionsRoot = Path.Combine(root, "transactions");
            var installRoot = Path.Combine(root, "installed");
            var packagePath = Path.Combine(root, "package.zip");
            Directory.CreateDirectory(installRoot);
            File.WriteAllText(packagePath, "package");
            var hash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(packagePath))).ToLowerInvariant();
            var journal = new UpdateTransactionJournal(transactionsRoot);
            var plan = new UpdateHandoffBroker.HandoffPlan(
                "startup-health-1",
                new Version(0, 5, 1),
                new Version(0, 5, 30),
                "stable",
                packagePath,
                hash,
                new FileInfo(packagePath).Length,
                "startup-health-tests",
                installRoot,
                Path.Combine(root, "handoff.json"),
                DateTimeOffset.UtcNow,
                "prepared");
            var state = journal.Begin(plan);
            state = journal.Transition(state, "applying");
            state = journal.Transition(state, "awaiting-health-check");
            var challenge = new UpdateHealthBroker(journal).Issue(state, TimeSpan.FromMinutes(2));

            SetEnvironment(state, challenge.Token);
            var handshake = StartupHealthHandshake.CaptureFromEnvironment();
            Expect(handshake is not null, "candidate update environment creates startup handshake");
            Expect(Environment.GetEnvironmentVariable(ControlledCandidateLauncher.HealthTokenEnvironment) is null, "raw health token is removed from process environment after capture");
            Expect(Environment.GetEnvironmentVariable(ControlledCandidateLauncher.TransactionEnvironment) is null, "transaction metadata is removed from process environment after capture");
            var committed = handshake!.ConfirmShellReady();
            Expect(committed.State == "committed", "shell readiness commits candidate update");
            ExpectCode("UPDATE_STARTUP_HEALTH_ALREADY_USED", () => handshake.ConfirmShellReady(), "startup health proof is one-shot");

            ClearEnvironment();
            Expect(StartupHealthHandshake.CaptureFromEnvironment() is null, "normal non-update launch does not create handshake");

            Environment.SetEnvironmentVariable(ControlledCandidateLauncher.TransactionEnvironment, "partial");
            ExpectCode("UPDATE_STARTUP_HEALTH_ENV_INCOMPLETE", () => StartupHealthHandshake.CaptureFromEnvironment(), "partial candidate environment is rejected");
            Expect(Environment.GetEnvironmentVariable(ControlledCandidateLauncher.TransactionEnvironment) is null, "invalid environment is cleared before rejection");

            Console.WriteLine($"SWIR startup health handshake self-tests passed: {_passed}");
        }
        finally
        {
            ClearEnvironment();
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    private static void SetEnvironment(UpdateTransactionJournal.TransactionState state, string token)
    {
        Environment.SetEnvironmentVariable(ControlledCandidateLauncher.TransactionEnvironment, state.TransactionId);
        Environment.SetEnvironmentVariable(ControlledCandidateLauncher.TargetVersionEnvironment, state.TargetVersion.ToString());
        Environment.SetEnvironmentVariable(ControlledCandidateLauncher.HealthTokenEnvironment, token);
        Environment.SetEnvironmentVariable(ControlledCandidateLauncher.JournalEnvironment, state.JournalPath);
    }

    private static void ClearEnvironment()
    {
        Environment.SetEnvironmentVariable(ControlledCandidateLauncher.TransactionEnvironment, null);
        Environment.SetEnvironmentVariable(ControlledCandidateLauncher.TargetVersionEnvironment, null);
        Environment.SetEnvironmentVariable(ControlledCandidateLauncher.HealthTokenEnvironment, null);
        Environment.SetEnvironmentVariable(ControlledCandidateLauncher.JournalEnvironment, null);
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
