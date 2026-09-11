using System.Text.Json;
using Swir.Desktop.Host;

internal static class UpdaterPackagedCandidateSelfTests
{
    private static int Main()
    {
        try
        {
            var modePath = Path.Combine(AppContext.BaseDirectory, "e2e-mode.txt");
            var mode = File.Exists(modePath) ? File.ReadAllText(modePath).Trim() : "healthy";
            var journalPath = Require(ControlledCandidateLauncher.JournalEnvironment);
            var transactionId = Require(ControlledCandidateLauncher.TransactionEnvironment);
            var targetVersionText = Require(ControlledCandidateLauncher.TargetVersionEnvironment);
            var token = Require(ControlledCandidateLauncher.HealthTokenEnvironment);
            var nonceLeaked = !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(HostShutdownHandoff.NonceEnvironmentVariable));

            var evidencePath = Path.Combine(AppContext.BaseDirectory, "candidate-evidence.json");
            File.WriteAllText(evidencePath, JsonSerializer.Serialize(new
            {
                schema = "swir.desktop-packaged-e2e-candidate/0.1",
                transactionId,
                targetVersion = targetVersionText,
                mode,
                shutdownNonceLeaked = nonceLeaked,
                processId = Environment.ProcessId,
                startedAt = DateTimeOffset.UtcNow
            }));

            if (nonceLeaked)
                return 71;

            if (string.Equals(mode, "early-exit", StringComparison.OrdinalIgnoreCase))
                return 41;

            if (!Version.TryParse(targetVersionText, out var targetVersion))
                return 72;

            var transactionDirectory = Path.GetDirectoryName(Path.GetFullPath(journalPath))
                ?? throw new InvalidOperationException("Candidate journal directory is invalid.");
            var transactionsRoot = Directory.GetParent(transactionDirectory)?.FullName
                ?? throw new InvalidOperationException("Candidate transactions root is invalid.");
            var journal = new UpdateTransactionJournal(transactionsRoot);
            var state = journal.Read(journalPath);
            if (!string.Equals(state.TransactionId, transactionId, StringComparison.Ordinal))
                return 73;

            var committed = new UpdateHealthBroker(journal).Confirm(state, token, targetVersion);
            if (!string.Equals(committed.State, "committed", StringComparison.Ordinal))
                return 74;

            // Remain alive beyond ControlledCandidateLauncher startup probe so the worker
            // can distinguish a healthy boot from an immediate crash.
            Thread.Sleep(TimeSpan.FromSeconds(4));
            return 0;
        }
        catch (Exception ex)
        {
            try { File.WriteAllText(Path.Combine(AppContext.BaseDirectory, "candidate-error.txt"), ex.ToString()); } catch { }
            return 70;
        }
    }

    private static string Require(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value))
            throw new InvalidOperationException($"Required candidate environment variable is missing: {name}");
        return value;
    }
}
