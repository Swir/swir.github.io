using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal sealed class UpdateStagingBroker
{
    public const string StageSchema = "swir.desktop-update-stage/0.1";
    private const int BufferSize = 128 * 1024;
    private readonly string _stagingRoot;

    public UpdateStagingBroker(string? stagingRoot = null)
    {
        _stagingRoot = Path.GetFullPath(stagingRoot ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "SWIR", "Updates", "Staging"));
        Directory.CreateDirectory(_stagingRoot);
    }

    public async Task<StagedUpdate> StageAsync(Stream packageStream, UpdateBroker.VerifiedUpdate update, CancellationToken cancellationToken = default)
    {
        if (packageStream is null) throw new ArgumentNullException(nameof(packageStream));
        if (update is null) throw new ArgumentNullException(nameof(update));
        if (!packageStream.CanRead) throw new UpdateSecurityException("UPDATE_PACKAGE_UNREADABLE", "Update package stream is not readable.");
        if (update.Size is <= 0 or > UpdateBroker.MaxPackageBytes)
            throw new UpdateSecurityException("UPDATE_PACKAGE_SIZE_INVALID", "Signed update package size is outside the allowed range.");

        var versionDir = SafeVersionDirectory(update.Version);
        Directory.CreateDirectory(versionDir);
        var finalPackagePath = Path.Combine(versionDir, "package.bin");
        var finalMetadataPath = Path.Combine(versionDir, "stage.json");
        var tempPackagePath = Path.Combine(versionDir, $".package-{Guid.NewGuid():N}.tmp");
        var tempMetadataPath = Path.Combine(versionDir, $".stage-{Guid.NewGuid():N}.tmp");

        try
        {
            long total = 0;
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            await using (var output = new FileStream(tempPackagePath, FileMode.CreateNew, FileAccess.Write, FileShare.None, BufferSize, FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                var buffer = new byte[BufferSize];
                while (true)
                {
                    var read = await packageStream.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken);
                    if (read == 0) break;
                    total += read;
                    if (total > update.Size || total > UpdateBroker.MaxPackageBytes)
                        throw new UpdateSecurityException("UPDATE_PACKAGE_SIZE_MISMATCH", "Downloaded update exceeds signed package size.");
                    hash.AppendData(buffer, 0, read);
                    await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                }
                await output.FlushAsync(cancellationToken);
            }

            if (total != update.Size)
                throw new UpdateSecurityException("UPDATE_PACKAGE_SIZE_MISMATCH", "Downloaded update size does not match signed metadata.");

            var actualHash = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(actualHash), Encoding.ASCII.GetBytes(update.Sha256)))
                throw new UpdateSecurityException("UPDATE_PACKAGE_HASH_MISMATCH", "Downloaded update SHA-256 does not match signed metadata.");

            var metadata = new StageMetadata(
                StageSchema,
                update.Version.ToString(),
                update.Channel,
                update.PackageUri.AbsoluteUri,
                actualHash,
                total,
                update.KeyId,
                DateTimeOffset.UtcNow);
            await File.WriteAllTextAsync(tempMetadataPath, JsonSerializer.Serialize(metadata, JsonOptions), Encoding.UTF8, cancellationToken);

            File.Move(tempPackagePath, finalPackagePath, true);
            File.Move(tempMetadataPath, finalMetadataPath, true);

            return new StagedUpdate(true, update.Version, update.Channel, finalPackagePath, finalMetadataPath, actualHash, total, update.KeyId);
        }
        catch (OperationCanceledException)
        {
            SafeDelete(tempPackagePath);
            SafeDelete(tempMetadataPath);
            throw;
        }
        catch
        {
            SafeDelete(tempPackagePath);
            SafeDelete(tempMetadataPath);
            throw;
        }
    }

    public StageStatus? GetStatus(Version version)
    {
        if (version is null) throw new ArgumentNullException(nameof(version));
        var versionDir = SafeVersionDirectory(version);
        var packagePath = Path.Combine(versionDir, "package.bin");
        var metadataPath = Path.Combine(versionDir, "stage.json");
        if (!File.Exists(packagePath) || !File.Exists(metadataPath)) return null;

        try
        {
            var metadata = JsonSerializer.Deserialize<StageMetadata>(File.ReadAllText(metadataPath), JsonOptions)
                ?? throw new UpdateSecurityException("UPDATE_STAGE_METADATA_INVALID", "Staged update metadata could not be decoded.");
            if (!string.Equals(metadata.Schema, StageSchema, StringComparison.Ordinal)
                || !string.Equals(metadata.Version, version.ToString(), StringComparison.Ordinal)
                || metadata.Size <= 0
                || string.IsNullOrWhiteSpace(metadata.Sha256))
                throw new UpdateSecurityException("UPDATE_STAGE_METADATA_INVALID", "Staged update metadata is invalid.");
            var info = new FileInfo(packagePath);
            if (info.Length != metadata.Size)
                throw new UpdateSecurityException("UPDATE_STAGE_SIZE_MISMATCH", "Staged package size no longer matches its verified metadata.");
            return new StageStatus(true, version, metadata.Channel, packagePath, metadata.Sha256, metadata.Size, metadata.KeyId, metadata.StagedAt);
        }
        catch (UpdateSecurityException) { throw; }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            throw new UpdateSecurityException("UPDATE_STAGE_METADATA_INVALID", "Staged update metadata is unreadable or invalid.");
        }
    }

    private string SafeVersionDirectory(Version version)
    {
        var segment = version.ToString();
        if (string.IsNullOrWhiteSpace(segment) || segment.Any(ch => !(char.IsDigit(ch) || ch == '.')))
            throw new UpdateSecurityException("UPDATE_VERSION_INVALID", "Update version cannot be mapped to a staging directory.");
        var candidate = Path.GetFullPath(Path.Combine(_stagingRoot, segment));
        var rootWithSeparator = _stagingRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!candidate.StartsWith(rootWithSeparator, StringComparison.OrdinalIgnoreCase))
            throw new UpdateSecurityException("UPDATE_STAGE_PATH_INVALID", "Update staging path escaped its sandbox.");
        return candidate;
    }

    private static void SafeDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch { }
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = false, WriteIndented = true };

    private sealed record StageMetadata(string Schema, string Version, string Channel, string PackageUrl, string Sha256, long Size, string KeyId, DateTimeOffset StagedAt);
    internal sealed record StagedUpdate(bool Verified, Version Version, string Channel, string PackagePath, string MetadataPath, string Sha256, long Size, string KeyId);
    internal sealed record StageStatus(bool Verified, Version Version, string Channel, string PackagePath, string Sha256, long Size, string KeyId, DateTimeOffset StagedAt);
}
