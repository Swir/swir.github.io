using System.Text;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal sealed class UpdateTransactionJournal
{
    public const string JournalSchema = "swir.desktop-update-transaction/0.1";
    private static readonly HashSet<string> AllowedStates = new(StringComparer.Ordinal)
    {
        "prepared",
        "applying",
        "awaiting-health-check",
        "committed",
        "rollback-pending",
        "rolled-back",
        "failed"
    };

    private readonly string _root;

    public UpdateTransactionJournal(string? root = null)
    {
        _root = Path.GetFullPath(root ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "SWIR", "Updates", "Transactions"));
        Directory.CreateDirectory(_root);
    }

    public TransactionState Begin(UpdateHandoffBroker.HandoffPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        if (!string.Equals(plan.State, "prepared", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_TRANSACTION_PLAN_INVALID", "Only a prepared handoff can begin an update transaction.");

        var transactionDir = SafeTransactionDirectory(plan.TransactionId);
        Directory.CreateDirectory(transactionDir);
        var journalPath = Path.Combine(transactionDir, "transaction.json");
        if (File.Exists(journalPath))
            return Read(journalPath);

        var now = DateTimeOffset.UtcNow;
        var state = new TransactionState(
            plan.TransactionId,
            plan.CurrentVersion,
            plan.TargetVersion,
            "prepared",
            plan.InstallRoot,
            plan.PackagePath,
            plan.Sha256,
            plan.Size,
            journalPath,
            now,
            now,
            null);
        Write(state);
        return state;
    }

    public TransactionState Transition(TransactionState current, string nextState, string? failureCode = null)
    {
        ArgumentNullException.ThrowIfNull(current);
        if (!AllowedStates.Contains(nextState))
            throw new UpdateSecurityException("UPDATE_TRANSACTION_STATE_INVALID", "Requested update transaction state is invalid.");

        var canonical = Read(current.JournalPath);
        if (!string.Equals(canonical.TransactionId, current.TransactionId, StringComparison.Ordinal)
            || !string.Equals(canonical.State, current.State, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_TRANSACTION_STALE", "Update transaction state changed on disk.");

        if (!CanTransition(canonical.State, nextState))
            throw new UpdateSecurityException("UPDATE_TRANSACTION_TRANSITION_DENIED", $"Transition {canonical.State} -> {nextState} is not allowed.");

        if (nextState == "failed" && string.IsNullOrWhiteSpace(failureCode))
            throw new UpdateSecurityException("UPDATE_TRANSACTION_FAILURE_CODE_REQUIRED", "Failed transactions require a failure code.");
        if (nextState != "failed" && failureCode is not null)
            throw new UpdateSecurityException("UPDATE_TRANSACTION_FAILURE_CODE_INVALID", "Failure code is only valid for failed transactions.");

        var updated = canonical with
        {
            State = nextState,
            UpdatedAt = DateTimeOffset.UtcNow,
            FailureCode = failureCode
        };
        Write(updated);
        return updated;
    }

    public TransactionState Read(string journalPath)
    {
        if (string.IsNullOrWhiteSpace(journalPath))
            throw new UpdateSecurityException("UPDATE_TRANSACTION_PATH_INVALID", "Transaction journal path is required.");
        var canonical = Path.GetFullPath(journalPath);
        var rootPrefix = _root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!canonical.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(Path.GetFileName(canonical), "transaction.json", StringComparison.OrdinalIgnoreCase))
            throw new UpdateSecurityException("UPDATE_TRANSACTION_PATH_INVALID", "Transaction journal escaped its sandbox or used a non-canonical filename.");
        if (!File.Exists(canonical))
            throw new UpdateSecurityException("UPDATE_TRANSACTION_MISSING", "Transaction journal does not exist.");

        try
        {
            var metadata = JsonSerializer.Deserialize<TransactionMetadata>(File.ReadAllText(canonical), JsonOptions)
                ?? throw new UpdateSecurityException("UPDATE_TRANSACTION_INVALID", "Transaction journal could not be decoded.");
            if (!string.Equals(metadata.Schema, JournalSchema, StringComparison.Ordinal)
                || string.IsNullOrWhiteSpace(metadata.TransactionId)
                || !Version.TryParse(metadata.CurrentVersion, out var currentVersion)
                || !Version.TryParse(metadata.TargetVersion, out var targetVersion)
                || targetVersion <= currentVersion
                || !AllowedStates.Contains(metadata.State)
                || string.IsNullOrWhiteSpace(metadata.InstallRoot)
                || string.IsNullOrWhiteSpace(metadata.PackagePath)
                || string.IsNullOrWhiteSpace(metadata.Sha256)
                || metadata.Sha256.Length != 64
                || metadata.Size is <= 0 or > UpdateBroker.MaxPackageBytes
                || metadata.CreatedAt == default
                || metadata.UpdatedAt < metadata.CreatedAt
                || metadata.UpdatedAt > DateTimeOffset.UtcNow.AddHours(24)
                || (metadata.State == "failed") != !string.IsNullOrWhiteSpace(metadata.FailureCode))
                throw new UpdateSecurityException("UPDATE_TRANSACTION_INVALID", "Transaction journal metadata is invalid.");

            if (!string.Equals(Path.GetFileName(Path.GetDirectoryName(canonical)), metadata.TransactionId, StringComparison.Ordinal))
                throw new UpdateSecurityException("UPDATE_TRANSACTION_INVALID", "Transaction directory does not match journal metadata.");

            return new TransactionState(
                metadata.TransactionId,
                currentVersion,
                targetVersion,
                metadata.State,
                Path.GetFullPath(metadata.InstallRoot),
                Path.GetFullPath(metadata.PackagePath),
                metadata.Sha256.ToLowerInvariant(),
                metadata.Size,
                canonical,
                metadata.CreatedAt,
                metadata.UpdatedAt,
                metadata.FailureCode);
        }
        catch (UpdateSecurityException) { throw; }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            throw new UpdateSecurityException("UPDATE_TRANSACTION_INVALID", "Transaction journal is unreadable or invalid.");
        }
    }

    public IReadOnlyList<TransactionState> RecoverIncomplete()
    {
        if (!Directory.Exists(_root)) return Array.Empty<TransactionState>();
        var recovered = new List<TransactionState>();
        foreach (var path in Directory.EnumerateFiles(_root, "transaction.json", SearchOption.AllDirectories))
        {
            var state = Read(path);
            if (state.State is not ("committed" or "rolled-back" or "failed"))
                recovered.Add(state);
        }
        return recovered.OrderBy(x => x.CreatedAt).ToArray();
    }

    private void Write(TransactionState state)
    {
        var directory = SafeTransactionDirectory(state.TransactionId);
        Directory.CreateDirectory(directory);
        var journalPath = Path.Combine(directory, "transaction.json");
        var tempPath = Path.Combine(directory, $".transaction-{Guid.NewGuid():N}.tmp");
        var metadata = new TransactionMetadata(
            JournalSchema,
            state.TransactionId,
            state.CurrentVersion.ToString(),
            state.TargetVersion.ToString(),
            state.State,
            state.InstallRoot,
            state.PackagePath,
            state.Sha256,
            state.Size,
            state.CreatedAt,
            state.UpdatedAt,
            state.FailureCode);
        try
        {
            File.WriteAllText(tempPath, JsonSerializer.Serialize(metadata, JsonOptions), Encoding.UTF8);
            File.Move(tempPath, journalPath, true);
        }
        catch
        {
            try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch { }
            throw;
        }
    }

    private string SafeTransactionDirectory(string transactionId)
    {
        if (string.IsNullOrWhiteSpace(transactionId)
            || transactionId.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '.' or '-')))
            throw new UpdateSecurityException("UPDATE_TRANSACTION_ID_INVALID", "Update transaction id is invalid.");
        var candidate = Path.GetFullPath(Path.Combine(_root, transactionId));
        var rootPrefix = _root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!candidate.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
            throw new UpdateSecurityException("UPDATE_TRANSACTION_PATH_INVALID", "Update transaction path escaped its sandbox.");
        return candidate;
    }

    private static bool CanTransition(string current, string next) => (current, next) switch
    {
        ("prepared", "applying") => true,
        ("prepared", "failed") => true,
        ("applying", "awaiting-health-check") => true,
        ("applying", "rollback-pending") => true,
        ("applying", "failed") => true,
        ("awaiting-health-check", "committed") => true,
        ("awaiting-health-check", "rollback-pending") => true,
        ("awaiting-health-check", "failed") => true,
        ("rollback-pending", "rolled-back") => true,
        ("rollback-pending", "failed") => true,
        _ => false
    };

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = false, WriteIndented = true };

    private sealed record TransactionMetadata(
        string Schema,
        string TransactionId,
        string CurrentVersion,
        string TargetVersion,
        string State,
        string InstallRoot,
        string PackagePath,
        string Sha256,
        long Size,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt,
        string? FailureCode);

    internal sealed record TransactionState(
        string TransactionId,
        Version CurrentVersion,
        Version TargetVersion,
        string State,
        string InstallRoot,
        string PackagePath,
        string Sha256,
        long Size,
        string JournalPath,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt,
        string? FailureCode);
}
