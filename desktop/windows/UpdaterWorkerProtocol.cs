using System.Text;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal sealed class UpdaterWorkerProtocol
{
    public const string WorkerPlanSchema = "swir.desktop-updater-worker/0.1";
    private readonly UpdateTransactionJournal _journal;
    private readonly string _deploymentRoot;

    public UpdaterWorkerProtocol(UpdateTransactionJournal journal, string deploymentRoot)
    {
        _journal = journal ?? throw new ArgumentNullException(nameof(journal));
        if (string.IsNullOrWhiteSpace(deploymentRoot))
            throw new UpdateSecurityException("UPDATE_WORKER_ROOT_INVALID", "Updater deployment root is required.");
        _deploymentRoot = Path.GetFullPath(deploymentRoot);
        Directory.CreateDirectory(_deploymentRoot);
    }

    public WorkerPlan Prepare(UpdateTransactionJournal.TransactionState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        var canonical = _journal.Read(state.JournalPath);
        if (!string.Equals(canonical.TransactionId, state.TransactionId, StringComparison.Ordinal)
            || !string.Equals(canonical.State, state.State, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_WORKER_TRANSACTION_STALE", "Updater worker cannot prepare from stale transaction state.");
        if (!string.Equals(canonical.State, "prepared", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_WORKER_STATE_INVALID", "Updater worker planning requires a prepared transaction.");

        var packagePath = Path.GetFullPath(canonical.PackagePath);
        if (!File.Exists(packagePath) || new FileInfo(packagePath).Length != canonical.Size)
            throw new UpdateSecurityException("UPDATE_WORKER_PACKAGE_INVALID", "Staged package no longer matches transaction metadata.");

        var currentRoot = SafeDeploymentChild("Current");
        var previousRoot = SafeDeploymentChild("Previous");
        var candidateBase = SafeDeploymentChild("Candidate");
        var candidateRoot = SafeDeploymentChild(Path.Combine("Candidate", canonical.TransactionId));
        Directory.CreateDirectory(candidateBase);
        Directory.CreateDirectory(candidateRoot);

        var journalDirectory = Path.GetDirectoryName(Path.GetFullPath(canonical.JournalPath))
            ?? throw new UpdateSecurityException("UPDATE_WORKER_PLAN_PATH_INVALID", "Transaction journal directory is invalid.");
        var planPath = Path.Combine(journalDirectory, "worker-plan.json");

        if (File.Exists(planPath))
            return Read(planPath, canonical);

        var createdAt = DateTimeOffset.UtcNow;
        var metadata = new WorkerPlanMetadata(
            WorkerPlanSchema,
            canonical.TransactionId,
            canonical.CurrentVersion.ToString(),
            canonical.TargetVersion.ToString(),
            packagePath,
            canonical.Sha256,
            canonical.Size,
            Path.GetFullPath(canonical.InstallRoot),
            currentRoot,
            previousRoot,
            candidateRoot,
            "planned",
            createdAt);
        AtomicWrite(planPath, metadata);
        return ToPlan(metadata, planPath);
    }

    public WorkerPlan Read(string planPath, UpdateTransactionJournal.TransactionState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        if (string.IsNullOrWhiteSpace(planPath))
            throw new UpdateSecurityException("UPDATE_WORKER_PLAN_PATH_INVALID", "Updater worker plan path is required.");

        var canonicalState = _journal.Read(state.JournalPath);
        var canonicalPlan = Path.GetFullPath(planPath);
        var journalDirectory = Path.GetDirectoryName(Path.GetFullPath(canonicalState.JournalPath))
            ?? throw new UpdateSecurityException("UPDATE_WORKER_PLAN_PATH_INVALID", "Transaction journal directory is invalid.");
        var expectedPlan = Path.Combine(journalDirectory, "worker-plan.json");
        if (!string.Equals(canonicalPlan, expectedPlan, StringComparison.OrdinalIgnoreCase) || !File.Exists(canonicalPlan))
            throw new UpdateSecurityException("UPDATE_WORKER_PLAN_PATH_INVALID", "Updater worker plan must remain beside the canonical transaction journal.");

        try
        {
            var metadata = JsonSerializer.Deserialize<WorkerPlanMetadata>(File.ReadAllText(canonicalPlan), JsonOptions)
                ?? throw new UpdateSecurityException("UPDATE_WORKER_PLAN_INVALID", "Updater worker plan could not be decoded.");
            if (!string.Equals(metadata.Schema, WorkerPlanSchema, StringComparison.Ordinal)
                || !string.Equals(metadata.TransactionId, canonicalState.TransactionId, StringComparison.Ordinal)
                || !Version.TryParse(metadata.CurrentVersion, out var currentVersion)
                || !Version.TryParse(metadata.TargetVersion, out var targetVersion)
                || currentVersion != canonicalState.CurrentVersion
                || targetVersion != canonicalState.TargetVersion
                || !string.Equals(Path.GetFullPath(metadata.PackagePath), Path.GetFullPath(canonicalState.PackagePath), StringComparison.OrdinalIgnoreCase)
                || !string.Equals(metadata.Sha256, canonicalState.Sha256, StringComparison.OrdinalIgnoreCase)
                || metadata.Size != canonicalState.Size
                || !string.Equals(Path.GetFullPath(metadata.InstallRoot), Path.GetFullPath(canonicalState.InstallRoot), StringComparison.OrdinalIgnoreCase)
                || !string.Equals(Path.GetFullPath(metadata.CurrentRoot), SafeDeploymentChild("Current"), StringComparison.OrdinalIgnoreCase)
                || !string.Equals(Path.GetFullPath(metadata.PreviousRoot), SafeDeploymentChild("Previous"), StringComparison.OrdinalIgnoreCase)
                || !string.Equals(Path.GetFullPath(metadata.CandidateRoot), SafeDeploymentChild(Path.Combine("Candidate", canonicalState.TransactionId)), StringComparison.OrdinalIgnoreCase)
                || !string.Equals(metadata.State, "planned", StringComparison.Ordinal)
                || metadata.CreatedAt == default
                || metadata.CreatedAt > DateTimeOffset.UtcNow.AddHours(24))
                throw new UpdateSecurityException("UPDATE_WORKER_PLAN_INVALID", "Updater worker plan metadata is invalid or no longer bound to the transaction.");

            EnsureDeploymentPath(metadata.CurrentRoot);
            EnsureDeploymentPath(metadata.PreviousRoot);
            EnsureDeploymentPath(metadata.CandidateRoot);
            return ToPlan(metadata, canonicalPlan);
        }
        catch (UpdateSecurityException) { throw; }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            throw new UpdateSecurityException("UPDATE_WORKER_PLAN_INVALID", "Updater worker plan is unreadable or invalid.");
        }
    }

    private string SafeDeploymentChild(string relativePath)
    {
        var candidate = Path.GetFullPath(Path.Combine(_deploymentRoot, relativePath));
        EnsureDeploymentPath(candidate);
        return candidate;
    }

    private void EnsureDeploymentPath(string path)
    {
        var canonical = Path.GetFullPath(path);
        var prefix = _deploymentRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!canonical.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new UpdateSecurityException("UPDATE_WORKER_PATH_ESCAPE", "Updater worker path escaped its deployment sandbox.");
    }

    private static void AtomicWrite(string path, WorkerPlanMetadata metadata)
    {
        var directory = Path.GetDirectoryName(path)
            ?? throw new UpdateSecurityException("UPDATE_WORKER_PLAN_PATH_INVALID", "Updater worker plan directory is invalid.");
        Directory.CreateDirectory(directory);
        var tempPath = Path.Combine(directory, $".worker-plan-{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllText(tempPath, JsonSerializer.Serialize(metadata, JsonOptions), Encoding.UTF8);
            File.Move(tempPath, path, true);
        }
        catch
        {
            try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch { }
            throw;
        }
    }

    private static WorkerPlan ToPlan(WorkerPlanMetadata metadata, string planPath) => new(
        metadata.TransactionId,
        Version.Parse(metadata.CurrentVersion),
        Version.Parse(metadata.TargetVersion),
        metadata.PackagePath,
        metadata.Sha256,
        metadata.Size,
        metadata.InstallRoot,
        metadata.CurrentRoot,
        metadata.PreviousRoot,
        metadata.CandidateRoot,
        metadata.State,
        metadata.CreatedAt,
        planPath);

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = false, WriteIndented = true };

    private sealed record WorkerPlanMetadata(
        string Schema,
        string TransactionId,
        string CurrentVersion,
        string TargetVersion,
        string PackagePath,
        string Sha256,
        long Size,
        string InstallRoot,
        string CurrentRoot,
        string PreviousRoot,
        string CandidateRoot,
        string State,
        DateTimeOffset CreatedAt);

    internal sealed record WorkerPlan(
        string TransactionId,
        Version CurrentVersion,
        Version TargetVersion,
        string PackagePath,
        string Sha256,
        long Size,
        string InstallRoot,
        string CurrentRoot,
        string PreviousRoot,
        string CandidateRoot,
        string State,
        DateTimeOffset CreatedAt,
        string PlanPath);
}
