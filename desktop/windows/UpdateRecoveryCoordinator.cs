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
    /// Interrupted applying transactions are either rolled back when slots moved or
    /// marked failed when the crash happened before Current was touched. Missing or
    /// expired health checks and persisted rollback-pending states are rolled back.
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
                var action = string.Equals(recovered.State, "rolled-back", StringComparison.Ordinal)
                    ? "interrupted-activation-rolled-back"
                    : "interrupted-before-swap-marked-failed";
                return Result(recovered, action, true);
            }

            case "awaiting-health-check":
                return RecoverHealthCheck(plan, state);

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

    private RecoveryResult RecoverHealthCheck(
        UpdaterWorkerProtocol.WorkerPlan plan,
        UpdateTransactionJournal.TransactionState state)
    {
        try
        {
            var status = _health.GetStatus(state);
            if (!status.Expired)
                return Result(state, "awaiting-health-check", false);

            var rollbackPending = _health.EvaluateTimeout(state);
            return CompleteRollback(plan, rollbackPending, "expired-health-check-rolled-back");
        }
        catch (UpdateSecurityException ex) when (ex.Code == "UPDATE_HEALTH_MISSING")
        {
            // Activation can reach awaiting-health-check immediately before the challenge
            // is persisted. A crash in that narrow window must not strand the deployment.
            var rollbackPending = _journal.Transition(state, "rollback-pending");
            return CompleteRollback(plan, rollbackPending, "missing-health-challenge-rolled-back");
        }
    }

    private RecoveryResult CompleteRollback(
        UpdaterWorkerProtocol.WorkerPlan plan,
        UpdateTransactionJournal.TransactionState rollbackPending,
        string action)
    {
        if (!string.Equals(rollbackPending.State, "rollback-pending", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_RECOVERY_ROLLBACK_INCOMPLETE", "Recovery did not reach rollback-pending state.");

        var rolledBack = _activator.Rollback(plan);
        if (!string.Equals(rolledBack.State, "rolled-back", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_RECOVERY_ROLLBACK_INCOMPLETE", "Recovery did not complete slot rollback.");
        return Result(rolledBack, action, true);
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
