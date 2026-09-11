using System.Security.Cryptography;
using System.Text;
using Swir.Desktop.Host;

internal static class HostShutdownHandoffSelfTests
{
    private static int _passed;

    private static void Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-host-shutdown-selftest-" + Guid.NewGuid().ToString("N"));
        var installRoot = Path.Combine(root, "install");
        var packagePath = Path.Combine(root, "package.bin");
        var previousNonceEnvironment = Environment.GetEnvironmentVariable(HostShutdownHandoff.NonceEnvironmentVariable);
        try
        {
            Directory.CreateDirectory(installRoot);
            var package = Encoding.UTF8.GetBytes("SWIR-HOST-SHUTDOWN-TEST");
            File.WriteAllBytes(packagePath, package);
            var hash = Convert.ToHexString(SHA256.HashData(package)).ToLowerInvariant();
            var journal = new UpdateTransactionJournal(Path.Combine(root, "transactions"));

            var capturedNonce = new string('a', 64);
            Environment.SetEnvironmentVariable(HostShutdownHandoff.NonceEnvironmentVariable, capturedNonce);
            Expect(HostShutdownHandoff.CaptureNonceFromEnvironment() == capturedNonce, "worker captures shutdown nonce from environment");
            Expect(Environment.GetEnvironmentVariable(HostShutdownHandoff.NonceEnvironmentVariable) is null, "captured shutdown nonce is removed before child processes can inherit it");
            ExpectCode("UPDATE_SHUTDOWN_NONCE_REQUIRED", () => HostShutdownHandoff.CaptureNonceFromEnvironment(), "shutdown nonce capture is one-shot");
            Environment.SetEnvironmentVariable(HostShutdownHandoff.NonceEnvironmentVariable, "invalid");
            ExpectCode("UPDATE_SHUTDOWN_NONCE_INVALID", () => HostShutdownHandoff.CaptureNonceFromEnvironment(), "invalid environment shutdown nonce is rejected");
            Expect(Environment.GetEnvironmentVariable(HostShutdownHandoff.NonceEnvironmentVariable) is null, "invalid shutdown nonce is still scrubbed from environment");

            var prepared = journal.Begin(NewPlan(root, installRoot, packagePath, hash, package.Length));
            var broker = new HostShutdownHandoff(journal, _ => false, _ => { });
            var ticket = broker.Issue(prepared, 4242, TimeSpan.FromSeconds(30));
            Expect(File.Exists(ticket.TicketPath), "shutdown ticket is persisted in transaction directory");
            Expect(ticket.Nonce.Length == 64, "shutdown nonce has 256-bit entropy");
            Expect(!File.ReadAllText(ticket.TicketPath).Contains(ticket.Nonce, StringComparison.OrdinalIgnoreCase), "raw shutdown nonce is never persisted");
            ExpectCode("UPDATE_SHUTDOWN_ALREADY_ISSUED", () => broker.Issue(prepared, 4242, TimeSpan.FromSeconds(30)), "shutdown nonce cannot be silently rotated");
            ExpectCode("UPDATE_SHUTDOWN_NONCE_MISMATCH", () => broker.VerifyAndWait(prepared, ticket.TicketPath, new string('0', 64), TimeSpan.FromSeconds(1)), "wrong shutdown nonce is rejected");

            var verified = broker.VerifyAndWait(prepared, ticket.TicketPath, ticket.Nonce, TimeSpan.FromSeconds(1));
            Expect(File.Exists(verified.ConsumedPath), "verified shutdown handoff is moved to consumed state");
            Expect(!File.Exists(ticket.TicketPath), "consumed shutdown ticket cannot be replayed from original path");
            ExpectCode("UPDATE_SHUTDOWN_MISSING", () => broker.VerifyAndWait(prepared, ticket.TicketPath, ticket.Nonce, TimeSpan.FromSeconds(1)), "consumed shutdown handoff cannot be replayed");

            var timeoutPrepared = journal.Begin(NewPlan(root, installRoot, packagePath, hash, package.Length));
            var timeoutBroker = new HostShutdownHandoff(journal, _ => true, _ => { });
            var timeoutTicket = timeoutBroker.Issue(timeoutPrepared, 5252, TimeSpan.FromSeconds(30));
            ExpectCode("UPDATE_SHUTDOWN_TIMEOUT", () => timeoutBroker.VerifyAndWait(timeoutPrepared, timeoutTicket.TicketPath, timeoutTicket.Nonce, TimeSpan.Zero), "worker refuses activation while old host is still alive");
            Expect(File.Exists(timeoutTicket.TicketPath), "timed-out shutdown ticket remains available for safe retry");

            var stalePrepared = journal.Begin(NewPlan(root, installRoot, packagePath, hash, package.Length));
            var staleTicket = broker.Issue(stalePrepared, 6262, TimeSpan.FromSeconds(30));
            _ = journal.Transition(stalePrepared, "applying");
            ExpectCode("UPDATE_SHUTDOWN_STATE_INVALID", () => broker.VerifyAndWait(stalePrepared, staleTicket.TicketPath, staleTicket.Nonce, TimeSpan.FromSeconds(1)), "shutdown handoff cannot authorize a transaction that already changed state");

            var invalidTtlPrepared = journal.Begin(NewPlan(root, installRoot, packagePath, hash, package.Length));
            ExpectCode("UPDATE_SHUTDOWN_TTL_INVALID", () => broker.Issue(invalidTtlPrepared, 7272, TimeSpan.FromMinutes(10)), "shutdown ticket rejects excessive lifetime");
            ExpectCode("UPDATE_SHUTDOWN_PID_INVALID", () => broker.Issue(invalidTtlPrepared, 0, TimeSpan.FromSeconds(30)), "shutdown ticket rejects invalid host PID");

            var escapedPrepared = journal.Begin(NewPlan(root, installRoot, packagePath, hash, package.Length));
            var escapedTicket = broker.Issue(escapedPrepared, 8282, TimeSpan.FromSeconds(30));
            ExpectCode("UPDATE_SHUTDOWN_PATH_INVALID", () => broker.VerifyAndWait(escapedPrepared, Path.Combine(root, "shutdown.json"), escapedTicket.Nonce, TimeSpan.FromSeconds(1)), "shutdown verification cannot escape transaction directory");

            Console.WriteLine($"SWIR Desktop Host Shutdown Handoff self-tests passed: {_passed}");
        }
        finally
        {
            Environment.SetEnvironmentVariable(HostShutdownHandoff.NonceEnvironmentVariable, previousNonceEnvironment);
            try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
        }
    }

    private static UpdateHandoffBroker.HandoffPlan NewPlan(string root, string installRoot, string packagePath, string hash, long packageLength)
        => new(
            "0.5.2-shutdown-" + Guid.NewGuid().ToString("N"),
            new Version(0, 5, 1),
            new Version(0, 5, 2),
            "stable",
            packagePath,
            hash,
            packageLength,
            "shutdown-selftest-2026",
            installRoot,
            Path.Combine(root, "handoff-" + Guid.NewGuid().ToString("N") + ".json"),
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
