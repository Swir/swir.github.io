using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal sealed class HostShutdownHandoff
{
    public const string HandoffSchema = "swir.desktop-host-shutdown/0.1";
    public const string NonceEnvironmentVariable = "SWIR_UPDATE_SHUTDOWN_NONCE";
    private readonly UpdateTransactionJournal _journal;
    private readonly Func<int, bool> _isProcessAlive;
    private readonly Action<TimeSpan> _sleep;

    public HostShutdownHandoff(
        UpdateTransactionJournal journal,
        Func<int, bool>? isProcessAlive = null,
        Action<TimeSpan>? sleep = null)
    {
        _journal = journal ?? throw new ArgumentNullException(nameof(journal));
        _isProcessAlive = isProcessAlive ?? IsProcessAlive;
        _sleep = sleep ?? Thread.Sleep;
    }

    public static string CaptureNonceFromEnvironment()
    {
        var nonce = Environment.GetEnvironmentVariable(NonceEnvironmentVariable);
        // The shutdown nonce authorizes a single updater handoff. Clear it before any
        // candidate process can inherit the worker environment.
        Environment.SetEnvironmentVariable(NonceEnvironmentVariable, null);
        if (string.IsNullOrWhiteSpace(nonce))
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_NONCE_REQUIRED", "Updater activation requires a shutdown nonce supplied by the exiting Desktop Host.");
        ValidateNonce(nonce);
        return nonce;
    }

    public ShutdownTicket Issue(UpdateTransactionJournal.TransactionState state, int hostProcessId, TimeSpan ttl)
    {
        ArgumentNullException.ThrowIfNull(state);
        var canonical = _journal.Read(state.JournalPath);
        if (!string.Equals(canonical.TransactionId, state.TransactionId, StringComparison.Ordinal)
            || !string.Equals(canonical.State, state.State, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_STALE", "Update transaction changed before shutdown handoff was issued.");
        if (!string.Equals(canonical.State, "prepared", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_STATE_INVALID", "Shutdown handoff can only be issued for a prepared transaction.");
        if (hostProcessId <= 0)
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_PID_INVALID", "Host process id is invalid.");
        if (ttl < TimeSpan.FromSeconds(5) || ttl > TimeSpan.FromMinutes(5))
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_TTL_INVALID", "Shutdown handoff TTL must be between 5 seconds and 5 minutes.");

        var transactionDirectory = Path.GetDirectoryName(Path.GetFullPath(canonical.JournalPath))
            ?? throw new UpdateSecurityException("UPDATE_SHUTDOWN_PATH_INVALID", "Transaction directory is invalid.");
        var ticketPath = Path.Combine(transactionDirectory, "shutdown.json");
        if (File.Exists(ticketPath))
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_ALREADY_ISSUED", "A shutdown handoff already exists for this transaction.");

        var nonceBytes = RandomNumberGenerator.GetBytes(32);
        var nonce = Convert.ToHexString(nonceBytes).ToLowerInvariant();
        var now = DateTimeOffset.UtcNow;
        var metadata = new ShutdownMetadata(
            HandoffSchema,
            canonical.TransactionId,
            canonical.TargetVersion.ToString(),
            hostProcessId,
            Sha256Hex(nonce),
            now,
            now.Add(ttl));
        WriteAtomically(ticketPath, metadata);
        return new ShutdownTicket(canonical.TransactionId, canonical.TargetVersion, hostProcessId, nonce, ticketPath, metadata.IssuedAt, metadata.ExpiresAt);
    }

    public VerifiedShutdown VerifyAndWait(
        UpdateTransactionJournal.TransactionState state,
        string ticketPath,
        string nonce,
        TimeSpan waitTimeout,
        TimeSpan? pollInterval = null)
    {
        ArgumentNullException.ThrowIfNull(state);
        var canonical = _journal.Read(state.JournalPath);
        if (!string.Equals(canonical.TransactionId, state.TransactionId, StringComparison.Ordinal)
            || !string.Equals(canonical.State, "prepared", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_STATE_INVALID", "Shutdown verification requires the canonical prepared transaction.");
        ValidateNonce(nonce);
        if (waitTimeout < TimeSpan.Zero || waitTimeout > TimeSpan.FromMinutes(5))
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_WAIT_INVALID", "Shutdown wait timeout is invalid.");

        var expectedDirectory = Path.GetDirectoryName(Path.GetFullPath(canonical.JournalPath))
            ?? throw new UpdateSecurityException("UPDATE_SHUTDOWN_PATH_INVALID", "Transaction directory is invalid.");
        var expectedPath = Path.Combine(expectedDirectory, "shutdown.json");
        var actualPath = Path.GetFullPath(ticketPath);
        if (!string.Equals(actualPath, expectedPath, StringComparison.OrdinalIgnoreCase))
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_PATH_INVALID", "Shutdown ticket escaped the transaction directory or used a non-canonical path.");
        if (!File.Exists(actualPath))
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_MISSING", "Shutdown ticket does not exist.");

        ShutdownMetadata metadata;
        try
        {
            metadata = JsonSerializer.Deserialize<ShutdownMetadata>(File.ReadAllText(actualPath), JsonOptions)
                ?? throw new UpdateSecurityException("UPDATE_SHUTDOWN_INVALID", "Shutdown ticket could not be decoded.");
        }
        catch (UpdateSecurityException) { throw; }
        catch (Exception ex)
        {
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_INVALID", $"Shutdown ticket could not be decoded: {ex.Message}");
        }

        if (!string.Equals(metadata.Schema, HandoffSchema, StringComparison.Ordinal)
            || !string.Equals(metadata.TransactionId, canonical.TransactionId, StringComparison.Ordinal)
            || !Version.TryParse(metadata.TargetVersion, out var targetVersion)
            || targetVersion != canonical.TargetVersion
            || metadata.HostProcessId <= 0
            || string.IsNullOrWhiteSpace(metadata.NonceHash)
            || metadata.NonceHash.Length != 64
            || !metadata.NonceHash.All(Uri.IsHexDigit)
            || metadata.IssuedAt == default
            || metadata.ExpiresAt <= metadata.IssuedAt
            || metadata.ExpiresAt - metadata.IssuedAt > TimeSpan.FromMinutes(5))
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_INVALID", "Shutdown ticket metadata is invalid.");
        if (DateTimeOffset.UtcNow > metadata.ExpiresAt)
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_EXPIRED", "Shutdown handoff expired before the updater acquired it.");

        var suppliedHash = Sha256Hex(nonce);
        if (!CryptographicOperations.FixedTimeEquals(Convert.FromHexString(metadata.NonceHash), Convert.FromHexString(suppliedHash)))
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_NONCE_MISMATCH", "Shutdown nonce did not match the issued handoff.");

        var interval = pollInterval ?? TimeSpan.FromMilliseconds(100);
        if (interval <= TimeSpan.Zero || interval > TimeSpan.FromSeconds(1))
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_POLL_INVALID", "Shutdown poll interval is invalid.");
        var deadline = DateTimeOffset.UtcNow.Add(waitTimeout);
        while (_isProcessAlive(metadata.HostProcessId))
        {
            if (DateTimeOffset.UtcNow >= deadline)
                throw new UpdateSecurityException("UPDATE_SHUTDOWN_TIMEOUT", "Desktop Host did not exit before the shutdown handoff timeout.");
            _sleep(interval);
        }

        var consumedPath = Path.Combine(expectedDirectory, "shutdown-consumed.json");
        if (File.Exists(consumedPath))
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_ALREADY_CONSUMED", "Shutdown handoff was already consumed.");
        File.Move(actualPath, consumedPath);
        return new VerifiedShutdown(canonical.TransactionId, canonical.TargetVersion, metadata.HostProcessId, consumedPath, DateTimeOffset.UtcNow);
    }

    private static void ValidateNonce(string? nonce)
    {
        if (string.IsNullOrWhiteSpace(nonce) || nonce.Length != 64 || !nonce.All(Uri.IsHexDigit))
            throw new UpdateSecurityException("UPDATE_SHUTDOWN_NONCE_INVALID", "Shutdown nonce is invalid.");
    }

    private static bool IsProcessAlive(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            return !process.HasExited;
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    private static string Sha256Hex(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static void WriteAtomically(string path, ShutdownMetadata metadata)
    {
        var tempPath = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllText(tempPath, JsonSerializer.Serialize(metadata, JsonOptions));
            File.Move(tempPath, path);
        }
        finally
        {
            if (File.Exists(tempPath)) File.Delete(tempPath);
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    internal sealed record ShutdownTicket(string TransactionId, Version TargetVersion, int HostProcessId, string Nonce, string TicketPath, DateTimeOffset IssuedAt, DateTimeOffset ExpiresAt);
    internal sealed record VerifiedShutdown(string TransactionId, Version TargetVersion, int HostProcessId, string ConsumedPath, DateTimeOffset VerifiedAt);
    private sealed record ShutdownMetadata(string Schema, string TransactionId, string TargetVersion, int HostProcessId, string NonceHash, DateTimeOffset IssuedAt, DateTimeOffset ExpiresAt);
}
