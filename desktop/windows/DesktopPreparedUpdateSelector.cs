namespace Swir.Desktop.Host;

/// <summary>
/// Resolves the one prepared Desktop update that is safe to hand to the restart
/// lifecycle. Selection is intentionally deterministic and fail-closed: the host
/// never guesses between multiple prepared transactions and never starts a restart
/// while another update still requires recovery.
/// </summary>
internal sealed class DesktopPreparedUpdateSelector
{
    public const string InventorySchema = "swir.desktop-prepared-update/0.1";

    private readonly UpdateTransactionJournal _journal;
    private readonly UpdaterWorkerProtocol _protocol;
    private readonly CandidatePackagePreparer _candidatePreparer;

    public DesktopPreparedUpdateSelector(
        UpdateTransactionJournal? journal = null,
        string? deploymentRoot = null,
        CandidatePackagePreparer? candidatePreparer = null)
    {
        _journal = journal ?? new UpdateTransactionJournal(DesktopUpdatePaths.TransactionsRoot);
        _protocol = new UpdaterWorkerProtocol(_journal, deploymentRoot ?? DesktopUpdatePaths.DeploymentRoot);
        _candidatePreparer = candidatePreparer ?? new CandidatePackagePreparer();
    }

    public PreparedUpdateInventory Inspect()
    {
        var incomplete = _journal.RecoverIncomplete();
        var prepared = incomplete.Where(state => string.Equals(state.State, "prepared", StringComparison.Ordinal)).ToArray();
        var active = incomplete.Where(state => !string.Equals(state.State, "prepared", StringComparison.Ordinal)).ToArray();

        string readiness;
        string? errorCode = null;
        if (active.Length != 0)
        {
            readiness = "recovery-required";
            errorCode = "UPDATE_RESTART_RECOVERY_REQUIRED";
        }
        else if (prepared.Length == 0)
        {
            readiness = "none";
            errorCode = "UPDATE_RESTART_NOT_READY";
        }
        else if (prepared.Length > 1)
        {
            readiness = "ambiguous";
            errorCode = "UPDATE_RESTART_AMBIGUOUS";
        }
        else
        {
            try
            {
                _ = ValidatePrepared(prepared[0]);
                readiness = "ready";
            }
            catch (UpdateSecurityException)
            {
                readiness = "candidate-not-ready";
                errorCode = "UPDATE_RESTART_CANDIDATE_NOT_READY";
            }
        }

        return new PreparedUpdateInventory(
            InventorySchema,
            readiness,
            prepared.Length,
            active.Length,
            prepared.Select(ToSummary).ToArray(),
            active.Select(ToSummary).ToArray(),
            errorCode);
    }

    public SelectedPreparedUpdate RequireReady()
    {
        var incomplete = _journal.RecoverIncomplete();
        var prepared = incomplete.Where(state => string.Equals(state.State, "prepared", StringComparison.Ordinal)).ToArray();
        var active = incomplete.Where(state => !string.Equals(state.State, "prepared", StringComparison.Ordinal)).ToArray();

        if (active.Length != 0)
            throw new UpdateSecurityException(
                "UPDATE_RESTART_RECOVERY_REQUIRED",
                "Desktop update restart is blocked while another update transaction requires recovery.");
        if (prepared.Length == 0)
            throw new UpdateSecurityException(
                "UPDATE_RESTART_NOT_READY",
                "No prepared Desktop update is ready to restart into.");
        if (prepared.Length != 1)
            throw new UpdateSecurityException(
                "UPDATE_RESTART_AMBIGUOUS",
                "Desktop update restart requires exactly one prepared transaction; selection will not guess between candidates.");

        try
        {
            return ValidatePrepared(prepared[0]);
        }
        catch (UpdateSecurityException ex) when (!string.Equals(ex.Code, "UPDATE_RESTART_CANDIDATE_NOT_READY", StringComparison.Ordinal))
        {
            throw new UpdateSecurityException(
                "UPDATE_RESTART_CANDIDATE_NOT_READY",
                $"Prepared Desktop update {prepared[0].TransactionId} no longer has a verified Candidate payload: {ex.Code}.");
        }
    }

    private SelectedPreparedUpdate ValidatePrepared(UpdateTransactionJournal.TransactionState state)
    {
        var canonical = _journal.Read(state.JournalPath);
        if (!string.Equals(canonical.State, "prepared", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_RESTART_CANDIDATE_NOT_READY", "Selected update is no longer prepared.");

        var transactionDirectory = Path.GetDirectoryName(Path.GetFullPath(canonical.JournalPath))
            ?? throw new UpdateSecurityException("UPDATE_RESTART_CANDIDATE_NOT_READY", "Prepared update transaction directory is invalid.");
        var planPath = Path.Combine(transactionDirectory, "worker-plan.json");
        var plan = _protocol.Read(planPath, canonical);
        var candidateStatePath = Path.Combine(Path.GetFullPath(plan.CandidateRoot), "candidate-state.json");
        var candidate = _candidatePreparer.ReadAndVerify(plan, candidateStatePath);

        return new SelectedPreparedUpdate(InventorySchema, canonical, plan, candidate, DateTimeOffset.UtcNow);
    }

    private static PreparedUpdateSummary ToSummary(UpdateTransactionJournal.TransactionState state)
        => new(state.TransactionId, state.CurrentVersion, state.TargetVersion, state.State, state.UpdatedAt);

    internal sealed record PreparedUpdateInventory(
        string Schema,
        string Readiness,
        int PreparedCount,
        int ActiveCount,
        IReadOnlyList<PreparedUpdateSummary> Prepared,
        IReadOnlyList<PreparedUpdateSummary> Active,
        string? ErrorCode);

    internal sealed record PreparedUpdateSummary(
        string TransactionId,
        Version CurrentVersion,
        Version TargetVersion,
        string State,
        DateTimeOffset UpdatedAt);

    internal sealed record SelectedPreparedUpdate(
        string Schema,
        UpdateTransactionJournal.TransactionState State,
        UpdaterWorkerProtocol.WorkerPlan Plan,
        CandidatePackagePreparer.CandidateState Candidate,
        DateTimeOffset VerifiedAt);
}
