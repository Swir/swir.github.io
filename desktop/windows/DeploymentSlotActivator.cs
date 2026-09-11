using System.Text;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal sealed class DeploymentSlotActivator
{
    public const string ActivationSchema = "swir.desktop-activation/0.1";
    private readonly UpdateTransactionJournal _journal;
    private readonly CandidatePackagePreparer _candidatePreparer;
    private readonly Action<string>? _failureInjector;

    public DeploymentSlotActivator(
        UpdateTransactionJournal journal,
        CandidatePackagePreparer? candidatePreparer = null,
        Action<string>? failureInjector = null)
    {
        _journal = journal ?? throw new ArgumentNullException(nameof(journal));
        _candidatePreparer = candidatePreparer ?? new CandidatePackagePreparer();
        _failureInjector = failureInjector;
    }

    public ActivationState Activate(UpdaterWorkerProtocol.WorkerPlan plan, CandidatePackagePreparer.CandidateState candidate)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(candidate);

        var transaction = _journal.Read(TransactionPath(plan));
        if (!string.Equals(transaction.TransactionId, plan.TransactionId, StringComparison.Ordinal)
            || !string.Equals(transaction.State, "prepared", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_ACTIVATION_STATE_INVALID", "Activation requires the canonical prepared transaction.");

        var verifiedCandidate = _candidatePreparer.ReadAndVerify(plan, candidate.StatePath);
        if (!string.Equals(verifiedCandidate.TransactionId, transaction.TransactionId, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_ACTIVATION_CANDIDATE_INVALID", "Candidate is not bound to the update transaction.");

        var currentRoot = CanonicalSlot(plan.CurrentRoot, "Current");
        var previousRoot = CanonicalSlot(plan.PreviousRoot, "Previous");
        var payloadRoot = Path.GetFullPath(verifiedCandidate.PayloadRoot);
        var candidateRoot = Path.GetFullPath(plan.CandidateRoot);
        EnsureChild(candidateRoot, payloadRoot, "UPDATE_ACTIVATION_CANDIDATE_INVALID");

        if (!Directory.Exists(currentRoot))
            throw new UpdateSecurityException("UPDATE_ACTIVATION_CURRENT_MISSING", "Current deployment slot is missing.");
        if (Directory.Exists(previousRoot))
            throw new UpdateSecurityException("UPDATE_ACTIVATION_PREVIOUS_OCCUPIED", "Previous deployment slot must be empty before activation.");
        if (!Directory.Exists(payloadRoot))
            throw new UpdateSecurityException("UPDATE_ACTIVATION_CANDIDATE_INVALID", "Verified candidate payload is missing.");

        var activationPath = ActivationPath(transaction.JournalPath);
        if (File.Exists(activationPath))
            throw new UpdateSecurityException("UPDATE_ACTIVATION_ALREADY_STARTED", "Activation metadata already exists for this transaction.");

        var state = new ActivationState(
            ActivationSchema,
            transaction.TransactionId,
            transaction.CurrentVersion.ToString(),
            transaction.TargetVersion.ToString(),
            currentRoot,
            previousRoot,
            payloadRoot,
            "prepared",
            DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow,
            activationPath);
        Write(state);

        transaction = _journal.Transition(transaction, "applying");
        _failureInjector?.Invoke("after-journal-applying");

        Directory.Move(currentRoot, previousRoot);
        state = PersistPhase(state, "current-backed-up");
        _failureInjector?.Invoke("after-current-backup");

        Directory.Move(payloadRoot, currentRoot);
        state = PersistPhase(state, "candidate-promoted");
        _failureInjector?.Invoke("after-candidate-promote");

        transaction = _journal.Transition(transaction, "awaiting-health-check");
        state = PersistPhase(state, "awaiting-health-check");
        return state;
    }

    public UpdateTransactionJournal.TransactionState RecoverApplying(UpdaterWorkerProtocol.WorkerPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var transaction = _journal.Read(TransactionPath(plan));
        if (!string.Equals(transaction.State, "applying", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_ACTIVATION_RECOVERY_STATE_INVALID", "Activation recovery only handles applying transactions.");

        var currentRoot = CanonicalSlot(plan.CurrentRoot, "Current");
        var previousRoot = CanonicalSlot(plan.PreviousRoot, "Previous");
        var candidateRoot = Path.GetFullPath(plan.CandidateRoot);
        var abandonedRoot = SafeChild(candidateRoot, "AbandonedCurrent");

        // Recovery is intentionally conservative: an interrupted swap never resumes forward.
        // If Previous exists, it is authoritative until a later health check commits the update.
        if (Directory.Exists(previousRoot))
        {
            if (Directory.Exists(currentRoot))
            {
                if (Directory.Exists(abandonedRoot))
                    throw new UpdateSecurityException("UPDATE_ACTIVATION_RECOVERY_BLOCKED", "Recovery quarantine is already occupied.");
                Directory.Move(currentRoot, abandonedRoot);
            }
            Directory.Move(previousRoot, currentRoot);
            var rollbackPending = _journal.Transition(transaction, "rollback-pending");
            return _journal.Transition(rollbackPending, "rolled-back");
        }

        if (!Directory.Exists(currentRoot))
            throw new UpdateSecurityException("UPDATE_ACTIVATION_RECOVERY_BLOCKED", "Neither Current nor Previous contains a recoverable deployment.");

        return _journal.Transition(transaction, "failed", "UPDATE_ACTIVATION_INTERRUPTED_PRE_SWAP");
    }

    public UpdateTransactionJournal.TransactionState Rollback(UpdaterWorkerProtocol.WorkerPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var transaction = _journal.Read(TransactionPath(plan));
        if (!string.Equals(transaction.State, "rollback-pending", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_ACTIVATION_ROLLBACK_STATE_INVALID", "Slot rollback requires rollback-pending transaction state.");

        var currentRoot = CanonicalSlot(plan.CurrentRoot, "Current");
        var previousRoot = CanonicalSlot(plan.PreviousRoot, "Previous");
        var failedRoot = SafeChild(Path.GetFullPath(plan.CandidateRoot), "FailedCurrent");
        if (!Directory.Exists(previousRoot))
            throw new UpdateSecurityException("UPDATE_ACTIVATION_ROLLBACK_BLOCKED", "Previous deployment slot is unavailable.");
        if (Directory.Exists(failedRoot))
            throw new UpdateSecurityException("UPDATE_ACTIVATION_ROLLBACK_BLOCKED", "Failed deployment quarantine is already occupied.");

        if (Directory.Exists(currentRoot))
            Directory.Move(currentRoot, failedRoot);
        Directory.Move(previousRoot, currentRoot);
        return _journal.Transition(transaction, "rolled-back");
    }

    public ActivationState Read(UpdaterWorkerProtocol.WorkerPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var path = ActivationPath(TransactionPath(plan));
        if (!File.Exists(path))
            throw new UpdateSecurityException("UPDATE_ACTIVATION_STATE_MISSING", "Activation state does not exist.");
        try
        {
            var state = JsonSerializer.Deserialize<ActivationState>(File.ReadAllText(path), JsonOptions)
                ?? throw new UpdateSecurityException("UPDATE_ACTIVATION_STATE_INVALID", "Activation state could not be decoded.");
            if (!string.Equals(state.Schema, ActivationSchema, StringComparison.Ordinal)
                || !string.Equals(state.TransactionId, plan.TransactionId, StringComparison.Ordinal)
                || !Version.TryParse(state.CurrentVersion, out var currentVersion)
                || !Version.TryParse(state.TargetVersion, out var targetVersion)
                || currentVersion != plan.CurrentVersion
                || targetVersion != plan.TargetVersion
                || state.Phase is not ("prepared" or "current-backed-up" or "candidate-promoted" or "awaiting-health-check")
                || state.CreatedAt == default
                || state.UpdatedAt < state.CreatedAt
                || state.UpdatedAt > DateTimeOffset.UtcNow.AddHours(24)
                || !string.Equals(Path.GetFullPath(state.CurrentRoot), Path.GetFullPath(plan.CurrentRoot), StringComparison.OrdinalIgnoreCase)
                || !string.Equals(Path.GetFullPath(state.PreviousRoot), Path.GetFullPath(plan.PreviousRoot), StringComparison.OrdinalIgnoreCase)
                || !string.Equals(Path.GetFullPath(state.ActivationPath), path, StringComparison.OrdinalIgnoreCase))
                throw new UpdateSecurityException("UPDATE_ACTIVATION_STATE_INVALID", "Activation state is invalid or no longer bound to the worker plan.");
            return state;
        }
        catch (UpdateSecurityException) { throw; }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            throw new UpdateSecurityException("UPDATE_ACTIVATION_STATE_INVALID", "Activation state is unreadable or invalid.");
        }
    }

    private ActivationState PersistPhase(ActivationState state, string phase)
    {
        var updated = state with { Phase = phase, UpdatedAt = DateTimeOffset.UtcNow };
        Write(updated);
        return updated;
    }

    private static string TransactionPath(UpdaterWorkerProtocol.WorkerPlan plan)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(plan.PlanPath))
            ?? throw new UpdateSecurityException("UPDATE_ACTIVATION_STATE_INVALID", "Worker plan directory is invalid.");
        return Path.Combine(directory, "transaction.json");
    }

    private static string ActivationPath(string journalPath)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(journalPath))
            ?? throw new UpdateSecurityException("UPDATE_ACTIVATION_STATE_INVALID", "Transaction journal directory is invalid.");
        return Path.Combine(directory, "activation.json");
    }

    private static string CanonicalSlot(string path, string expectedName)
    {
        var canonical = Path.GetFullPath(path);
        if (!string.Equals(Path.GetFileName(canonical.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)), expectedName, StringComparison.OrdinalIgnoreCase))
            throw new UpdateSecurityException("UPDATE_ACTIVATION_SLOT_INVALID", $"Deployment slot must use canonical {expectedName} directory.");
        return canonical;
    }

    private static void EnsureChild(string root, string path, string errorCode)
    {
        var canonicalRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var canonical = Path.GetFullPath(path);
        var prefix = canonicalRoot + Path.DirectorySeparatorChar;
        if (!canonical.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new UpdateSecurityException(errorCode, "Activation path escaped its candidate sandbox.");
    }

    private static string SafeChild(string root, string relative)
    {
        var canonicalRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var path = Path.GetFullPath(Path.Combine(canonicalRoot, relative));
        EnsureChild(canonicalRoot, path, "UPDATE_ACTIVATION_PATH_ESCAPE");
        return path;
    }

    private static void Write(ActivationState state)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(state.ActivationPath))
            ?? throw new UpdateSecurityException("UPDATE_ACTIVATION_STATE_INVALID", "Activation state directory is invalid.");
        Directory.CreateDirectory(directory);
        var tempPath = Path.Combine(directory, $".activation-{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllText(tempPath, JsonSerializer.Serialize(state, JsonOptions), Encoding.UTF8);
            File.Move(tempPath, state.ActivationPath, true);
        }
        catch
        {
            try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch { }
            throw;
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = false, WriteIndented = true };

    internal sealed record ActivationState(
        string Schema,
        string TransactionId,
        string CurrentVersion,
        string TargetVersion,
        string CurrentRoot,
        string PreviousRoot,
        string CandidatePayloadRoot,
        string Phase,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt,
        string ActivationPath);
}
