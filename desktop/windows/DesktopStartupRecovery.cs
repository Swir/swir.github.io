namespace Swir.Desktop.Host;

/// <summary>
/// Reconciles incomplete Desktop update transactions before WebView2 and the shell
/// are started. Recovery is intentionally fail-closed for active transactions:
/// ambiguous state never gets hidden behind a normally running shell.
/// </summary>
internal sealed class DesktopStartupRecovery
{
    public const string ReportSchema = "swir.desktop-startup-recovery/0.1";

    private readonly UpdateTransactionJournal _journal;
    private readonly UpdaterWorkerProtocol _protocol;
    private readonly UpdateRecoveryCoordinator _recovery;

    public DesktopStartupRecovery(
        string? transactionsRoot = null,
        string? deploymentRoot = null,
        Func<DateTimeOffset>? clock = null)
    {
        var canonicalTransactionsRoot = Path.GetFullPath(transactionsRoot ?? DesktopUpdatePaths.TransactionsRoot);
        var canonicalDeploymentRoot = Path.GetFullPath(deploymentRoot ?? DesktopUpdatePaths.DeploymentRoot);
        _journal = new UpdateTransactionJournal(canonicalTransactionsRoot);
        _protocol = new UpdaterWorkerProtocol(_journal, canonicalDeploymentRoot);
        _recovery = new UpdateRecoveryCoordinator(
            _journal,
            new UpdateHealthBroker(_journal, clock),
            new DeploymentSlotActivator(_journal));
    }

    public StartupRecoveryReport RecoverBeforeShellStart()
    {
        var incomplete = _journal.RecoverIncomplete();
        if (incomplete.Count == 0)
            return new StartupRecoveryReport(ReportSchema, 0, 0, Array.Empty<StartupRecoveryItem>());

        var items = new List<StartupRecoveryItem>(incomplete.Count);
        var changed = 0;
        foreach (var state in incomplete)
        {
            // A merely prepared update has not touched Current and is safe to leave pending.
            if (string.Equals(state.State, "prepared", StringComparison.Ordinal))
            {
                items.Add(new StartupRecoveryItem(state.TransactionId, state.State, "no-action-prepared", false, state.JournalPath));
                continue;
            }

            var transactionDirectory = Path.GetDirectoryName(Path.GetFullPath(state.JournalPath))
                ?? throw new UpdateSecurityException("UPDATE_STARTUP_RECOVERY_PATH_INVALID", "Transaction journal directory is invalid.");
            var planPath = Path.Combine(transactionDirectory, "worker-plan.json");
            if (!File.Exists(planPath))
                throw new UpdateSecurityException(
                    "UPDATE_STARTUP_RECOVERY_PLAN_MISSING",
                    $"Active transaction {state.TransactionId} has no canonical worker plan; shell startup is blocked to avoid hiding ambiguous deployment state.");

            var plan = _protocol.Read(planPath, state);
            var result = _recovery.Recover(plan);
            if (result.Changed) changed++;
            items.Add(new StartupRecoveryItem(result.TransactionId, result.State, result.Action, result.Changed, result.JournalPath));
        }

        return new StartupRecoveryReport(ReportSchema, incomplete.Count, changed, items.ToArray());
    }

    internal sealed record StartupRecoveryReport(
        string Schema,
        int IncompleteTransactions,
        int ChangedTransactions,
        IReadOnlyList<StartupRecoveryItem> Items);

    internal sealed record StartupRecoveryItem(
        string TransactionId,
        string State,
        string Action,
        bool Changed,
        string JournalPath);
}
