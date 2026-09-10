using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal sealed class UpdateHandoffBroker
{
    public const string PlanSchema = "swir.desktop-update-handoff/0.1";
    private readonly string _pendingRoot;

    public UpdateHandoffBroker(string? pendingRoot = null)
    {
        _pendingRoot = Path.GetFullPath(pendingRoot ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "SWIR", "Updates", "Pending"));
        Directory.CreateDirectory(_pendingRoot);
    }

    public HandoffPlan Prepare(
        UpdateStagingBroker.StageStatus stage,
        Version currentVersion,
        string currentInstallRoot)
    {
        if (stage is null) throw new ArgumentNullException(nameof(stage));
        if (currentVersion is null) throw new ArgumentNullException(nameof(currentVersion));
        if (!stage.Verified) throw new UpdateSecurityException("UPDATE_STAGE_UNVERIFIED", "Only a verified staged update can be prepared for handoff.");
        if (stage.Version <= currentVersion) throw new UpdateSecurityException("UPDATE_HANDOFF_DOWNGRADE_BLOCKED", "Handoff target must be newer than the installed version.");
        if (string.IsNullOrWhiteSpace(currentInstallRoot)) throw new UpdateSecurityException("UPDATE_INSTALL_ROOT_INVALID", "Current installation root is required.");

        var installRoot = Path.GetFullPath(currentInstallRoot);
        if (!Directory.Exists(installRoot))
            throw new UpdateSecurityException("UPDATE_INSTALL_ROOT_INVALID", "Current installation root does not exist.");

        var packagePath = Path.GetFullPath(stage.PackagePath);
        if (!File.Exists(packagePath))
            throw new UpdateSecurityException("UPDATE_STAGE_PACKAGE_MISSING", "Staged update package no longer exists.");
        var info = new FileInfo(packagePath);
        if (info.Length != stage.Size)
            throw new UpdateSecurityException("UPDATE_STAGE_SIZE_MISMATCH", "Staged package size changed after verification.");

        var actualHash = HashFile(packagePath);
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(actualHash),
                Encoding.ASCII.GetBytes(stage.Sha256.ToLowerInvariant())))
            throw new UpdateSecurityException("UPDATE_STAGE_HASH_MISMATCH", "Staged package hash changed after verification.");

        var transactionId = $"{stage.Version}-{Guid.NewGuid():N}";
        var transactionDir = SafeTransactionDirectory(transactionId);
        Directory.CreateDirectory(transactionDir);

        var planPath = Path.Combine(transactionDir, "handoff.json");
        var tempPath = Path.Combine(transactionDir, $".handoff-{Guid.NewGuid():N}.tmp");
        var createdAt = DateTimeOffset.UtcNow;
        var payload = new PlanMetadata(
            PlanSchema,
            transactionId,
            currentVersion.ToString(),
            stage.Version.ToString(),
            stage.Channel,
            packagePath,
            stage.Sha256.ToLowerInvariant(),
            stage.Size,
            stage.KeyId,
            installRoot,
            "prepared",
            createdAt);

        try
        {
            File.WriteAllText(tempPath, JsonSerializer.Serialize(payload, JsonOptions), Encoding.UTF8);
            File.Move(tempPath, planPath, true);
        }
        catch
        {
            SafeDelete(tempPath);
            throw;
        }

        return new HandoffPlan(
            transactionId,
            currentVersion,
            stage.Version,
            stage.Channel,
            packagePath,
            stage.Sha256.ToLowerInvariant(),
            stage.Size,
            stage.KeyId,
            installRoot,
            planPath,
            createdAt,
            "prepared");
    }

    public HandoffPlan Read(string planPath)
    {
        if (string.IsNullOrWhiteSpace(planPath))
            throw new UpdateSecurityException("UPDATE_HANDOFF_PATH_INVALID", "Handoff plan path is required.");
        var canonical = Path.GetFullPath(planPath);
        var rootWithSeparator = _pendingRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!canonical.StartsWith(rootWithSeparator, StringComparison.OrdinalIgnoreCase))
            throw new UpdateSecurityException("UPDATE_HANDOFF_PATH_INVALID", "Handoff plan escaped its pending update sandbox.");
        if (!File.Exists(canonical))
            throw new UpdateSecurityException("UPDATE_HANDOFF_MISSING", "Handoff plan does not exist.");

        try
        {
            var metadata = JsonSerializer.Deserialize<PlanMetadata>(File.ReadAllText(canonical), JsonOptions)
                ?? throw new UpdateSecurityException("UPDATE_HANDOFF_INVALID", "Handoff plan could not be decoded.");
            if (!string.Equals(metadata.Schema, PlanSchema, StringComparison.Ordinal)
                || !Version.TryParse(metadata.CurrentVersion, out var currentVersion)
                || !Version.TryParse(metadata.TargetVersion, out var targetVersion)
                || targetVersion <= currentVersion
                || metadata.Size <= 0
                || metadata.Size > UpdateBroker.MaxPackageBytes
                || string.IsNullOrWhiteSpace(metadata.PackagePath)
                || string.IsNullOrWhiteSpace(metadata.InstallRoot)
                || string.IsNullOrWhiteSpace(metadata.TransactionId)
                || !string.Equals(metadata.State, "prepared", StringComparison.Ordinal))
                throw new UpdateSecurityException("UPDATE_HANDOFF_INVALID", "Handoff plan metadata is invalid.");

            var packagePath = Path.GetFullPath(metadata.PackagePath);
            if (!File.Exists(packagePath) || new FileInfo(packagePath).Length != metadata.Size)
                throw new UpdateSecurityException("UPDATE_STAGE_SIZE_MISMATCH", "Staged package no longer matches handoff metadata.");
            var actualHash = HashFile(packagePath);
            if (!CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(actualHash),
                    Encoding.ASCII.GetBytes(metadata.Sha256.ToLowerInvariant())))
                throw new UpdateSecurityException("UPDATE_STAGE_HASH_MISMATCH", "Staged package hash no longer matches handoff metadata.");

            return new HandoffPlan(
                metadata.TransactionId,
                currentVersion,
                targetVersion,
                metadata.Channel,
                packagePath,
                metadata.Sha256.ToLowerInvariant(),
                metadata.Size,
                metadata.KeyId,
                Path.GetFullPath(metadata.InstallRoot),
                canonical,
                metadata.CreatedAt,
                metadata.State);
        }
        catch (UpdateSecurityException) { throw; }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            throw new UpdateSecurityException("UPDATE_HANDOFF_INVALID", "Handoff plan is unreadable or invalid.");
        }
    }

    private string SafeTransactionDirectory(string transactionId)
    {
        if (string.IsNullOrWhiteSpace(transactionId)
            || transactionId.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '.' or '-')))
            throw new UpdateSecurityException("UPDATE_HANDOFF_ID_INVALID", "Update handoff transaction id is invalid.");
        var candidate = Path.GetFullPath(Path.Combine(_pendingRoot, transactionId));
        var rootWithSeparator = _pendingRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!candidate.StartsWith(rootWithSeparator, StringComparison.OrdinalIgnoreCase))
            throw new UpdateSecurityException("UPDATE_HANDOFF_PATH_INVALID", "Update handoff path escaped its sandbox.");
        return candidate;
    }

    private static string HashFile(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, FileOptions.SequentialScan);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static void SafeDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch { }
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = false, WriteIndented = true };

    private sealed record PlanMetadata(
        string Schema,
        string TransactionId,
        string CurrentVersion,
        string TargetVersion,
        string Channel,
        string PackagePath,
        string Sha256,
        long Size,
        string KeyId,
        string InstallRoot,
        string State,
        DateTimeOffset CreatedAt);

    internal sealed record HandoffPlan(
        string TransactionId,
        Version CurrentVersion,
        Version TargetVersion,
        string Channel,
        string PackagePath,
        string Sha256,
        long Size,
        string KeyId,
        string InstallRoot,
        string PlanPath,
        DateTimeOffset CreatedAt,
        string State);
}
