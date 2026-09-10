using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal sealed class UpdateHealthBroker
{
    public const string HealthSchema = "swir.desktop-update-health/0.1";
    private static readonly TimeSpan MinTtl = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan MaxTtl = TimeSpan.FromMinutes(30);

    private readonly UpdateTransactionJournal _journal;
    private readonly Func<DateTimeOffset> _clock;

    public UpdateHealthBroker(UpdateTransactionJournal journal, Func<DateTimeOffset>? clock = null)
    {
        _journal = journal ?? throw new ArgumentNullException(nameof(journal));
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    public HealthChallenge Issue(UpdateTransactionJournal.TransactionState state, TimeSpan? ttl = null)
    {
        ArgumentNullException.ThrowIfNull(state);
        var canonical = _journal.Read(state.JournalPath);
        if (!string.Equals(canonical.TransactionId, state.TransactionId, StringComparison.Ordinal)
            || !string.Equals(canonical.State, state.State, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_HEALTH_TRANSACTION_STALE", "Health challenge cannot be issued from stale transaction state.");
        if (!string.Equals(canonical.State, "awaiting-health-check", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_HEALTH_STATE_INVALID", "Health challenge requires awaiting-health-check transaction state.");

        var requestedTtl = ttl ?? TimeSpan.FromMinutes(5);
        if (requestedTtl < MinTtl || requestedTtl > MaxTtl)
            throw new UpdateSecurityException("UPDATE_HEALTH_TTL_INVALID", "Health challenge TTL is outside the allowed range.");

        var now = _clock();
        var tokenBytes = RandomNumberGenerator.GetBytes(32);
        var token = Convert.ToHexString(tokenBytes).ToLowerInvariant();
        var tokenHash = Convert.ToHexString(SHA256.HashData(Encoding.ASCII.GetBytes(token))).ToLowerInvariant();
        var metadata = new HealthMetadata(
            HealthSchema,
            canonical.TransactionId,
            canonical.TargetVersion.ToString(),
            tokenHash,
            now,
            now.Add(requestedTtl),
            null);

        var healthPath = HealthPath(canonical);
        AtomicWrite(healthPath, metadata);
        return new HealthChallenge(canonical.TransactionId, canonical.TargetVersion, token, metadata.ExpiresAt, healthPath);
    }

    public UpdateTransactionJournal.TransactionState Confirm(
        UpdateTransactionJournal.TransactionState state,
        string token,
        Version runningVersion)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(runningVersion);
        if (string.IsNullOrWhiteSpace(token))
            throw new UpdateSecurityException("UPDATE_HEALTH_TOKEN_INVALID", "Health confirmation token is required.");

        var canonical = _journal.Read(state.JournalPath);
        if (!string.Equals(canonical.State, "awaiting-health-check", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_HEALTH_STATE_INVALID", "Health confirmation is only valid while awaiting health check.");
        if (runningVersion != canonical.TargetVersion)
            throw new UpdateSecurityException("UPDATE_HEALTH_VERSION_MISMATCH", "Running version does not match the update target version.");

        var metadata = ReadMetadata(canonical);
        if (!string.Equals(metadata.TransactionId, canonical.TransactionId, StringComparison.Ordinal)
            || !Version.TryParse(metadata.TargetVersion, out var targetVersion)
            || targetVersion != canonical.TargetVersion)
            throw new UpdateSecurityException("UPDATE_HEALTH_METADATA_INVALID", "Health challenge does not match the active transaction.");
        if (_clock() > metadata.ExpiresAt)
            throw new UpdateSecurityException("UPDATE_HEALTH_EXPIRED", "Health confirmation window has expired.");
        if (metadata.ConfirmedAt is not null)
            throw new UpdateSecurityException("UPDATE_HEALTH_ALREADY_CONFIRMED", "Health challenge was already confirmed.");

        var suppliedHash = SHA256.HashData(Encoding.ASCII.GetBytes(token.Trim().ToLowerInvariant()));
        byte[] expectedHash;
        try { expectedHash = Convert.FromHexString(metadata.TokenHash); }
        catch (FormatException)
        {
            throw new UpdateSecurityException("UPDATE_HEALTH_METADATA_INVALID", "Health token hash metadata is invalid.");
        }
        if (!CryptographicOperations.FixedTimeEquals(suppliedHash, expectedHash))
            throw new UpdateSecurityException("UPDATE_HEALTH_TOKEN_INVALID", "Health confirmation token is invalid.");

        // The journal is authoritative. Commit first so a concurrent timeout/commit
        // cannot leave health metadata marked confirmed while the transaction is still pending.
        var committed = _journal.Transition(canonical, "committed");
        var confirmed = metadata with { ConfirmedAt = _clock() };
        AtomicWrite(HealthPath(committed), confirmed);
        return committed;
    }

    public UpdateTransactionJournal.TransactionState EvaluateTimeout(UpdateTransactionJournal.TransactionState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        var canonical = _journal.Read(state.JournalPath);
        if (!string.Equals(canonical.State, "awaiting-health-check", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_HEALTH_STATE_INVALID", "Timeout evaluation is only valid while awaiting health check.");

        var metadata = ReadMetadata(canonical);
        if (metadata.ConfirmedAt is not null)
            throw new UpdateSecurityException("UPDATE_HEALTH_ALREADY_CONFIRMED", "Confirmed health challenge cannot time out.");
        if (_clock() <= metadata.ExpiresAt)
            throw new UpdateSecurityException("UPDATE_HEALTH_NOT_EXPIRED", "Health confirmation window has not expired.");

        return _journal.Transition(canonical, "rollback-pending");
    }

    public HealthStatus GetStatus(UpdateTransactionJournal.TransactionState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        var canonical = _journal.Read(state.JournalPath);
        var metadata = ReadMetadata(canonical);
        return new HealthStatus(
            metadata.TransactionId,
            Version.Parse(metadata.TargetVersion),
            metadata.CreatedAt,
            metadata.ExpiresAt,
            metadata.ConfirmedAt,
            _clock() > metadata.ExpiresAt && metadata.ConfirmedAt is null,
            HealthPath(canonical));
    }

    private HealthMetadata ReadMetadata(UpdateTransactionJournal.TransactionState state)
    {
        var path = HealthPath(state);
        if (!File.Exists(path))
            throw new UpdateSecurityException("UPDATE_HEALTH_MISSING", "Health challenge metadata does not exist.");
        try
        {
            var metadata = JsonSerializer.Deserialize<HealthMetadata>(File.ReadAllText(path), JsonOptions)
                ?? throw new UpdateSecurityException("UPDATE_HEALTH_METADATA_INVALID", "Health challenge metadata could not be decoded.");
            if (!string.Equals(metadata.Schema, HealthSchema, StringComparison.Ordinal)
                || string.IsNullOrWhiteSpace(metadata.TransactionId)
                || !Version.TryParse(metadata.TargetVersion, out _)
                || string.IsNullOrWhiteSpace(metadata.TokenHash)
                || metadata.TokenHash.Length != 64
                || metadata.CreatedAt == default
                || metadata.ExpiresAt <= metadata.CreatedAt
                || metadata.ExpiresAt - metadata.CreatedAt > MaxTtl
                || metadata.CreatedAt > _clock().AddHours(24)
                || metadata.ConfirmedAt < metadata.CreatedAt
                || metadata.ConfirmedAt > metadata.ExpiresAt)
                throw new UpdateSecurityException("UPDATE_HEALTH_METADATA_INVALID", "Health challenge metadata is invalid.");
            return metadata;
        }
        catch (UpdateSecurityException) { throw; }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            throw new UpdateSecurityException("UPDATE_HEALTH_METADATA_INVALID", "Health challenge metadata is unreadable or invalid.");
        }
    }

    private static string HealthPath(UpdateTransactionJournal.TransactionState state)
    {
        var journal = Path.GetFullPath(state.JournalPath);
        var directory = Path.GetDirectoryName(journal)
            ?? throw new UpdateSecurityException("UPDATE_HEALTH_PATH_INVALID", "Transaction journal directory is invalid.");
        return Path.Combine(directory, "health.json");
    }

    private static void AtomicWrite(string path, HealthMetadata metadata)
    {
        var directory = Path.GetDirectoryName(path)
            ?? throw new UpdateSecurityException("UPDATE_HEALTH_PATH_INVALID", "Health challenge directory is invalid.");
        Directory.CreateDirectory(directory);
        var tempPath = Path.Combine(directory, $".health-{Guid.NewGuid():N}.tmp");
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

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = false, WriteIndented = true };

    private sealed record HealthMetadata(
        string Schema,
        string TransactionId,
        string TargetVersion,
        string TokenHash,
        DateTimeOffset CreatedAt,
        DateTimeOffset ExpiresAt,
        DateTimeOffset? ConfirmedAt);

    internal sealed record HealthChallenge(
        string TransactionId,
        Version TargetVersion,
        string Token,
        DateTimeOffset ExpiresAt,
        string HealthPath);

    internal sealed record HealthStatus(
        string TransactionId,
        Version TargetVersion,
        DateTimeOffset CreatedAt,
        DateTimeOffset ExpiresAt,
        DateTimeOffset? ConfirmedAt,
        bool Expired,
        string HealthPath);
}
