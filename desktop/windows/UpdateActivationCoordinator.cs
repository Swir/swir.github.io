namespace Swir.Desktop.Host;

/// <summary>
/// Couples slot activation with health challenge creation so a promoted candidate is
/// never intentionally left in awaiting-health-check without a usable challenge.
/// If challenge creation fails, the coordinator immediately restores Previous as Current.
/// </summary>
internal sealed class UpdateActivationCoordinator
{
    private readonly UpdateTransactionJournal _journal;
    private readonly DeploymentSlotActivator _activator;
    private readonly UpdateHealthBroker _health;

    public UpdateActivationCoordinator(
        UpdateTransactionJournal journal,
        DeploymentSlotActivator activator,
        UpdateHealthBroker health)
    {
        _journal = journal ?? throw new ArgumentNullException(nameof(journal));
        _activator = activator ?? throw new ArgumentNullException(nameof(activator));
        _health = health ?? throw new ArgumentNullException(nameof(health));
    }

    public ActivationReady ActivateAndIssueHealth(
        UpdaterWorkerProtocol.WorkerPlan plan,
        CandidatePackagePreparer.CandidateState candidate,
        TimeSpan? healthTtl = null)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(candidate);

        var activation = _activator.Activate(plan, candidate);
        if (!string.Equals(activation.Phase, "awaiting-health-check", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_ACTIVATION_HEALTH_STATE_INVALID", "Activation did not reach awaiting-health-check.");

        var awaiting = ReadCanonical(plan);
        try
        {
            var challenge = _health.Issue(awaiting, healthTtl);
            return new ActivationReady(
                awaiting.TransactionId,
                awaiting.TargetVersion,
                activation,
                challenge);
        }
        catch (Exception issueError)
        {
            try
            {
                var canonical = ReadCanonical(plan);
                if (string.Equals(canonical.State, "awaiting-health-check", StringComparison.Ordinal))
                {
                    _journal.Transition(canonical, "rollback-pending");
                    _activator.Rollback(plan);
                }
            }
            catch (Exception rollbackError)
            {
                throw new UpdateSecurityException(
                    "UPDATE_ACTIVATION_HEALTH_ROLLBACK_FAILED",
                    $"Health challenge creation failed and rollback could not be completed. Health error: {issueError.Message}; rollback error: {rollbackError.Message}");
            }

            if (issueError is UpdateSecurityException security)
                throw new UpdateSecurityException(
                    "UPDATE_ACTIVATION_HEALTH_FAILED",
                    $"Health challenge creation failed after activation and the previous deployment was restored. Cause: {security.Code}: {security.Message}");

            throw new UpdateSecurityException(
                "UPDATE_ACTIVATION_HEALTH_FAILED",
                $"Health challenge creation failed after activation and the previous deployment was restored. Cause: {issueError.GetType().Name}: {issueError.Message}");
        }
    }

    private UpdateTransactionJournal.TransactionState ReadCanonical(UpdaterWorkerProtocol.WorkerPlan plan)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(plan.PlanPath))
            ?? throw new UpdateSecurityException("UPDATE_ACTIVATION_HEALTH_PATH_INVALID", "Worker plan directory is invalid.");
        var state = _journal.Read(Path.Combine(directory, "transaction.json"));
        if (!string.Equals(state.TransactionId, plan.TransactionId, StringComparison.Ordinal)
            || state.CurrentVersion != plan.CurrentVersion
            || state.TargetVersion != plan.TargetVersion)
            throw new UpdateSecurityException("UPDATE_ACTIVATION_HEALTH_PLAN_MISMATCH", "Worker plan is not bound to the canonical transaction.");
        return state;
    }

    internal sealed record ActivationReady(
        string TransactionId,
        Version TargetVersion,
        DeploymentSlotActivator.ActivationState Activation,
        UpdateHealthBroker.HealthChallenge HealthChallenge);
}
