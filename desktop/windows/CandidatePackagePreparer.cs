using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal sealed class CandidatePackagePreparer
{
    public const string PackageManifestSchema = "swir.desktop-package/0.1";
    public const string CandidateStateSchema = "swir.desktop-candidate/0.1";
    public const string ManifestEntryName = "desktop-package.json";
    public const int MaxFiles = 4096;
    public const long MaxExpandedBytes = 1024L * 1024L * 1024L;
    public const long MaxSingleFileBytes = 512L * 1024L * 1024L;

    public CandidateState Prepare(UpdaterWorkerProtocol.WorkerPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        if (!string.Equals(plan.State, "planned", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_CANDIDATE_PLAN_INVALID", "Candidate preparation requires a planned updater worker transaction.");

        var candidateRoot = Path.GetFullPath(plan.CandidateRoot);
        var payloadRoot = SafeChild(candidateRoot, "Payload");
        var statePath = SafeChild(candidateRoot, "candidate-state.json");
        Directory.CreateDirectory(candidateRoot);

        if (File.Exists(statePath))
            return ReadAndVerify(plan, statePath);
        if (Directory.Exists(payloadRoot))
            throw new UpdateSecurityException("UPDATE_CANDIDATE_PARTIAL", "Candidate payload exists without committed candidate state.");

        var packagePath = Path.GetFullPath(plan.PackagePath);
        if (!File.Exists(packagePath))
            throw new UpdateSecurityException("UPDATE_CANDIDATE_PACKAGE_MISSING", "Staged update package is missing.");

        var packageInfo = new FileInfo(packagePath);
        if (packageInfo.Length != plan.Size)
            throw new UpdateSecurityException("UPDATE_CANDIDATE_PACKAGE_INVALID", "Staged update package size no longer matches the worker plan.");
        VerifyPackageHash(packagePath, plan.Sha256);

        var tempRoot = SafeChild(candidateRoot, $".payload-{Guid.NewGuid():N}.tmp");
        Directory.CreateDirectory(tempRoot);
        try
        {
            PackageManifest manifest;
            long expandedBytes = 0;
            using (var archive = ZipFile.OpenRead(packagePath))
            {
                if (archive.Entries.Count > MaxFiles + 1)
                    throw new UpdateSecurityException("UPDATE_CANDIDATE_TOO_MANY_FILES", "Desktop update package contains too many archive entries.");

                var manifestEntries = archive.Entries.Where(e => string.Equals(NormalizeArchivePath(e.FullName), ManifestEntryName, StringComparison.OrdinalIgnoreCase)).ToArray();
                if (manifestEntries.Length != 1 || IsDirectory(manifestEntries[0]) || IsSymlink(manifestEntries[0]))
                    throw new UpdateSecurityException("UPDATE_CANDIDATE_MANIFEST_INVALID", "Desktop update package must contain exactly one regular root manifest.");

                manifest = ReadManifest(manifestEntries[0]);
                ValidateManifest(manifest, plan);

                var archiveFiles = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
                foreach (var entry in archive.Entries)
                {
                    var normalized = NormalizeArchivePath(entry.FullName);
                    if (string.Equals(normalized, ManifestEntryName, StringComparison.OrdinalIgnoreCase))
                        continue;
                    ValidateRelativePath(normalized);
                    if (IsSymlink(entry))
                        throw new UpdateSecurityException("UPDATE_CANDIDATE_LINK_BLOCKED", "Symbolic links are not allowed in Desktop update packages.");
                    if (IsDirectory(entry))
                        continue;
                    if (!archiveFiles.TryAdd(normalized, entry))
                        throw new UpdateSecurityException("UPDATE_CANDIDATE_DUPLICATE_PATH", "Desktop update package contains duplicate file paths.");
                }

                if (archiveFiles.Count != manifest.Files.Count)
                    throw new UpdateSecurityException("UPDATE_CANDIDATE_MANIFEST_MISMATCH", "Archive file set does not match the signed package manifest.");

                foreach (var file in manifest.Files)
                {
                    var normalized = NormalizeArchivePath(file.Path);
                    if (!archiveFiles.TryGetValue(normalized, out var entry))
                        throw new UpdateSecurityException("UPDATE_CANDIDATE_MANIFEST_MISMATCH", $"Package manifest file is missing from archive: {normalized}");
                    if (file.Size < 0 || file.Size > MaxSingleFileBytes || entry.Length != file.Size)
                        throw new UpdateSecurityException("UPDATE_CANDIDATE_FILE_SIZE_INVALID", $"Invalid size for candidate file: {normalized}");
                    checked { expandedBytes += file.Size; }
                    if (expandedBytes > MaxExpandedBytes)
                        throw new UpdateSecurityException("UPDATE_CANDIDATE_EXPANDED_LIMIT", "Desktop update package exceeds the expanded size limit.");

                    var destination = SafeChild(tempRoot, normalized.Replace('/', Path.DirectorySeparatorChar));
                    Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                    using var input = entry.Open();
                    using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 128 * 1024, FileOptions.SequentialScan);
                    using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                    var buffer = new byte[128 * 1024];
                    long written = 0;
                    int read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        written += read;
                        if (written > file.Size || written > MaxSingleFileBytes)
                            throw new UpdateSecurityException("UPDATE_CANDIDATE_FILE_SIZE_INVALID", $"Candidate file exceeded declared size: {normalized}");
                        hash.AppendData(buffer, 0, read);
                        output.Write(buffer, 0, read);
                    }
                    output.Flush(true);
                    if (written != file.Size)
                        throw new UpdateSecurityException("UPDATE_CANDIDATE_FILE_SIZE_INVALID", $"Candidate file size changed while extracting: {normalized}");
                    var actualHash = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
                    if (!FixedHashEquals(actualHash, file.Sha256))
                        throw new UpdateSecurityException("UPDATE_CANDIDATE_FILE_HASH_INVALID", $"Candidate file hash mismatch: {normalized}");
                }
            }

            var entryPoint = SafeChild(tempRoot, NormalizeArchivePath(manifest.EntryPoint).Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(entryPoint))
                throw new UpdateSecurityException("UPDATE_CANDIDATE_ENTRYPOINT_INVALID", "Candidate entry point is missing after extraction.");

            Directory.Move(tempRoot, payloadRoot);
            var state = new CandidateState(
                CandidateStateSchema,
                plan.TransactionId,
                plan.TargetVersion.ToString(),
                manifest.EntryPoint,
                manifest.Files.Count,
                expandedBytes,
                plan.Sha256.ToLowerInvariant(),
                payloadRoot,
                DateTimeOffset.UtcNow,
                statePath);
            AtomicWrite(statePath, state);
            return state;
        }
        catch
        {
            try { if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, true); } catch { }
            throw;
        }
    }

    public CandidateState ReadAndVerify(UpdaterWorkerProtocol.WorkerPlan plan, string statePath)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var expectedStatePath = SafeChild(Path.GetFullPath(plan.CandidateRoot), "candidate-state.json");
        var canonicalStatePath = Path.GetFullPath(statePath);
        if (!string.Equals(canonicalStatePath, expectedStatePath, StringComparison.OrdinalIgnoreCase) || !File.Exists(canonicalStatePath))
            throw new UpdateSecurityException("UPDATE_CANDIDATE_STATE_INVALID", "Candidate state must remain inside the transaction candidate root.");

        try
        {
            var state = JsonSerializer.Deserialize<CandidateState>(File.ReadAllText(canonicalStatePath), JsonOptions)
                ?? throw new UpdateSecurityException("UPDATE_CANDIDATE_STATE_INVALID", "Candidate state could not be decoded.");
            var expectedPayload = SafeChild(Path.GetFullPath(plan.CandidateRoot), "Payload");
            if (!string.Equals(state.Schema, CandidateStateSchema, StringComparison.Ordinal)
                || !string.Equals(state.TransactionId, plan.TransactionId, StringComparison.Ordinal)
                || !string.Equals(state.TargetVersion, plan.TargetVersion.ToString(), StringComparison.Ordinal)
                || state.FileCount <= 0 || state.FileCount > MaxFiles
                || state.ExpandedBytes < 0 || state.ExpandedBytes > MaxExpandedBytes
                || !FixedHashEquals(state.PackageSha256, plan.Sha256)
                || !string.Equals(Path.GetFullPath(state.PayloadRoot), expectedPayload, StringComparison.OrdinalIgnoreCase)
                || state.PreparedAt == default || state.PreparedAt > DateTimeOffset.UtcNow.AddHours(24)
                || !string.Equals(Path.GetFullPath(state.StatePath), canonicalStatePath, StringComparison.OrdinalIgnoreCase)
                || !Directory.Exists(expectedPayload))
                throw new UpdateSecurityException("UPDATE_CANDIDATE_STATE_INVALID", "Candidate state is invalid or no longer bound to the worker plan.");
            ValidateRelativePath(NormalizeArchivePath(state.EntryPoint));
            if (!File.Exists(SafeChild(expectedPayload, NormalizeArchivePath(state.EntryPoint).Replace('/', Path.DirectorySeparatorChar))))
                throw new UpdateSecurityException("UPDATE_CANDIDATE_ENTRYPOINT_INVALID", "Prepared candidate entry point is missing.");
            return state;
        }
        catch (UpdateSecurityException) { throw; }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            throw new UpdateSecurityException("UPDATE_CANDIDATE_STATE_INVALID", "Candidate state is unreadable or invalid.");
        }
    }

    private static PackageManifest ReadManifest(ZipArchiveEntry entry)
    {
        if (entry.Length <= 0 || entry.Length > 1024 * 1024)
            throw new UpdateSecurityException("UPDATE_CANDIDATE_MANIFEST_INVALID", "Desktop package manifest size is invalid.");
        using var stream = entry.Open();
        return JsonSerializer.Deserialize<PackageManifest>(stream, JsonOptions)
            ?? throw new UpdateSecurityException("UPDATE_CANDIDATE_MANIFEST_INVALID", "Desktop package manifest could not be decoded.");
    }

    private static void ValidateManifest(PackageManifest manifest, UpdaterWorkerProtocol.WorkerPlan plan)
    {
        if (!string.Equals(manifest.Schema, PackageManifestSchema, StringComparison.Ordinal)
            || !Version.TryParse(manifest.Version, out var version)
            || version != plan.TargetVersion
            || manifest.Files is null || manifest.Files.Count == 0 || manifest.Files.Count > MaxFiles)
            throw new UpdateSecurityException("UPDATE_CANDIDATE_MANIFEST_INVALID", "Desktop package manifest metadata is invalid.");

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in manifest.Files)
        {
            var path = NormalizeArchivePath(file.Path);
            ValidateRelativePath(path);
            if (string.Equals(path, ManifestEntryName, StringComparison.OrdinalIgnoreCase) || !seen.Add(path)
                || !IsSha256(file.Sha256) || file.Size < 0 || file.Size > MaxSingleFileBytes)
                throw new UpdateSecurityException("UPDATE_CANDIDATE_MANIFEST_INVALID", "Desktop package file manifest contains invalid or duplicate metadata.");
        }

        var entryPoint = NormalizeArchivePath(manifest.EntryPoint);
        ValidateRelativePath(entryPoint);
        if (!seen.Contains(entryPoint))
            throw new UpdateSecurityException("UPDATE_CANDIDATE_ENTRYPOINT_INVALID", "Desktop package entry point must reference a manifested file.");
    }

    private static void ValidateRelativePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || Path.IsPathRooted(path) || path.Contains(':') || path.Contains('\\'))
            throw new UpdateSecurityException("UPDATE_CANDIDATE_PATH_INVALID", "Desktop package contains an invalid relative path.");
        var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0 || parts.Any(p => p is "." or ".." || p.Length == 0))
            throw new UpdateSecurityException("UPDATE_CANDIDATE_PATH_INVALID", "Desktop package path traversal is blocked.");
    }

    private static string NormalizeArchivePath(string path) => (path ?? string.Empty).Replace('\\', '/').TrimEnd('/');

    private static string SafeChild(string root, string relativePath)
    {
        var canonicalRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var candidate = Path.GetFullPath(Path.Combine(canonicalRoot, relativePath));
        var prefix = canonicalRoot + Path.DirectorySeparatorChar;
        if (!candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new UpdateSecurityException("UPDATE_CANDIDATE_PATH_ESCAPE", "Candidate path escaped its transaction sandbox.");
        return candidate;
    }

    private static bool IsDirectory(ZipArchiveEntry entry) => string.IsNullOrEmpty(entry.Name) || entry.FullName.EndsWith('/') || entry.FullName.EndsWith('\\');

    private static bool IsSymlink(ZipArchiveEntry entry)
    {
        var unixMode = (entry.ExternalAttributes >> 16) & 0xF000;
        return unixMode == 0xA000;
    }

    private static void VerifyPackageHash(string path, string expected)
    {
        if (!IsSha256(expected))
            throw new UpdateSecurityException("UPDATE_CANDIDATE_PACKAGE_INVALID", "Worker plan package hash is invalid.");
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, FileOptions.SequentialScan);
        var actual = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        if (!FixedHashEquals(actual, expected))
            throw new UpdateSecurityException("UPDATE_CANDIDATE_PACKAGE_INVALID", "Staged update package hash no longer matches the worker plan.");
    }

    private static bool IsSha256(string value) => value is { Length: 64 } && value.All(Uri.IsHexDigit);

    private static bool FixedHashEquals(string left, string right)
    {
        if (!IsSha256(left) || !IsSha256(right)) return false;
        return CryptographicOperations.FixedTimeEquals(Convert.FromHexString(left), Convert.FromHexString(right));
    }

    private static void AtomicWrite(string path, CandidateState state)
    {
        var directory = Path.GetDirectoryName(path)!;
        var tempPath = Path.Combine(directory, $".candidate-state-{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllText(tempPath, JsonSerializer.Serialize(state, JsonOptions), Encoding.UTF8);
            File.Move(tempPath, path, true);
        }
        catch
        {
            try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch { }
            throw;
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = false, WriteIndented = true };

    internal sealed record PackageManifest(string Schema, string Version, string EntryPoint, List<PackageFile> Files);
    internal sealed record PackageFile(string Path, string Sha256, long Size);
    internal sealed record CandidateState(
        string Schema,
        string TransactionId,
        string TargetVersion,
        string EntryPoint,
        int FileCount,
        long ExpandedBytes,
        string PackageSha256,
        string PayloadRoot,
        DateTimeOffset PreparedAt,
        string StatePath);
}
