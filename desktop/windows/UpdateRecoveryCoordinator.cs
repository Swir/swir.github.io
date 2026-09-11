namespace Swir.Desktop.Host;

/// <summary>
/// Coordinates crash/timeout recovery across the transaction journal, health broker,
/// and deployment slots. It intentionally prefers a known-good rollback over trying
/// to continue an ambiguous update forward.
/// </summary>
internal sealed class UpdateRecoveryCoordinator
{
    private readonly UpdateTransactionJournal _journal;
    private readonly UpdateHealthBroker _health;
    private readonly DeploymentSlotActivator _activator;

    public UpdateRecoveryCoordinator(
        UpdateTransactionJournal journal,
        UpdateHealthBroker health,
        DeploymentSlotActivator activator)
    {
        _journal = journal ?? throw new ArgumentNullException(nameof(journal));
        _health = health ?? throw new ArgumentNullException(nameof(health));
        _activator = activator ?? throw new ArgumentNullException(nameof(activator));
    }

    /// <summary>
    /// Reconciles one updater transaction after worker/host startup.
    /// Prepared and non-expired health-check transactions are left untouched.
    /// Interrupted applying transactions and expired health checks are rolled back.
    /// A previously persisted rollback-pending transaction resumes its rollback.
    /// </summary>
    public RecoveryResult Recover(UpdaterWorkerProtocol.WorkerPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var state = _journal.Read(TransactionPath(plan));
        EnsureBound(plan, state);

        switch (state.State)
        {
            case "prepared":
                return Result(state, "no-action-prepared", false);

            case "applying":
            {
                var recovered = _activator.RecoverApplying(plan);
                return Result(recovered, "interrupted-activation-rolled-back", true);
            }

            case "awaiting-health-check":
            {
                var status = _health.GetStatus(state);
                if (!status.Expired)
                    return Result(state, "awaiting-health-check", false);

                var rollbackPending = _health.EvaluateTimeout(state);
                var rolledBack = _activator.Rollback(plan);
                if (!string.Equals(rollbackPending.State, "rollback-pending", StringComparison.Ordinal)
                    || !string.Equals(rolledBack.State, "rolled-back", StringComparison.Ordinal))
                    throw new UpdateSecurityException("UPDATE_RECOVERY_ROLLBACK_INCOMPLETE", "Expired update did not complete rollback.");
                return Result(rolledBack, "expired-health-check-rolled-back", true);
            }

            case "rollback-pending":
            {
                var rolledBack = _activator.Rollback(plan);
                return Result(rolledBack, "pending-rollback-completed", true);
            }

            case "committed":
            case "rolled-back":
            case "failed":
                return Result(state, "terminal", false);

            default:
                throw new UpdateSecurityException("UPDATE_RECOVERY_STATE_INVALID", $"Unsupported update recovery state: {state.State}");
        }
    }

    private static void EnsureBound(UpdaterWorkerProtocol.WorkerPlan plan, UpdateTransactionJournal.TransactionState state)
    {
        if (!string.Equals(state.TransactionId, plan.TransactionId, StringComparison.Ordinal)
            || state.CurrentVersion != plan.CurrentVersion
            || state.TargetVersion != plan.TargetVersion)
            throw new UpdateSecurityException("UPDATE_RECOVERY_PLAN_MISMATCH", "Worker plan is not bound to the canonical transaction.");
    }

    private static RecoveryResult Result(UpdateTransactionJournal.TransactionState state, string action, bool changed)
        => new(state.TransactionId, state.State, action, changed, state.JournalPath);

    private static string TransactionPath(UpdaterWorkerProtocol.WorkerPlan plan)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(plan.PlanPath))
            ?? throw new UpdateSecurityException("UPDATE_RECOVERY_PATH_INVALID", "Worker plan directory is invalid.");
        return Path.Combine(directory, "transaction.json");
    }

    internal sealed record RecoveryResult(
        string TransactionId,
        string State,
        string Action,
        bool Changed,
        string JournalPath);
}
