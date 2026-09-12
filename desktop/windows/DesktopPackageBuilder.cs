using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopPackageBuilder
{
    public const string BuilderSchema = "swir.desktop-package-builder/0.1";
    public const string PackageManifestSchema = "swir.desktop-package/0.1";
    public const string ManifestEntryName = "desktop-package.json";
    public const int MaxFiles = 4096;
    public const long MaxExpandedBytes = 1024L * 1024L * 1024L;
    public const long MaxSingleFileBytes = 512L * 1024L * 1024L;

    private static readonly DateTimeOffset DeterministicTimestamp = new(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    internal sealed record PackageFile(string Path, string Sha256, long Size);
    internal sealed record PackageManifest(string Schema, string Version, string EntryPoint, List<PackageFile> Files);
    internal sealed record PackageBuildResult(string Schema, string PackagePath, string Version, string EntryPoint, int FileCount, long ExpandedBytes, string Sha256);

    public static PackageBuildResult Build(string sourceDirectory, string outputPackagePath, Version version, string entryPoint)
    {
        if (string.IsNullOrWhiteSpace(sourceDirectory))
            throw new UpdateSecurityException("UPDATE_PACKAGE_SOURCE_INVALID", "Desktop package source directory is required.");
        if (string.IsNullOrWhiteSpace(outputPackagePath))
            throw new UpdateSecurityException("UPDATE_PACKAGE_OUTPUT_INVALID", "Desktop package output path is required.");
        if (version is null || version <= new Version(0, 0))
            throw new UpdateSecurityException("UPDATE_PACKAGE_VERSION_INVALID", "Desktop package version must be positive.");

        var sourceRoot = Path.GetFullPath(sourceDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (!Directory.Exists(sourceRoot))
            throw new UpdateSecurityException("UPDATE_PACKAGE_SOURCE_MISSING", "Desktop package source directory does not exist.");

        var outputPath = Path.GetFullPath(outputPackagePath);
        if (IsInside(sourceRoot, outputPath))
            throw new UpdateSecurityException("UPDATE_PACKAGE_OUTPUT_INVALID", "Desktop package output must be outside the source tree.");

        var normalizedEntryPoint = NormalizeRelativePath(entryPoint);
        ValidateRelativePath(normalizedEntryPoint);

        var files = new List<PackageFile>();
        long expandedBytes = 0;
        foreach (var path in Directory.EnumerateFiles(sourceRoot, "*", SearchOption.AllDirectories))
        {
            var info = new FileInfo(path);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new UpdateSecurityException("UPDATE_PACKAGE_LINK_BLOCKED", "Reparse points and symbolic links are not allowed in Desktop release packages.");

            var relative = NormalizeRelativePath(Path.GetRelativePath(sourceRoot, path));
            ValidateRelativePath(relative);
            if (string.Equals(relative, ManifestEntryName, StringComparison.OrdinalIgnoreCase))
                throw new UpdateSecurityException("UPDATE_PACKAGE_RESERVED_PATH", $"Source tree contains reserved package path: {ManifestEntryName}");
            if (info.Length < 0 || info.Length > MaxSingleFileBytes)
                throw new UpdateSecurityException("UPDATE_PACKAGE_FILE_SIZE_INVALID", $"Desktop package file is outside the supported size range: {relative}");

            checked { expandedBytes += info.Length; }
            if (expandedBytes > MaxExpandedBytes)
                throw new UpdateSecurityException("UPDATE_PACKAGE_EXPANDED_LIMIT", "Desktop package exceeds the maximum expanded size.");

            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, FileOptions.SequentialScan);
            var sha256 = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
            files.Add(new PackageFile(relative, sha256, info.Length));
        }

        files.Sort((left, right) => StringComparer.Ordinal.Compare(left.Path, right.Path));
        if (files.Count == 0 || files.Count > MaxFiles)
            throw new UpdateSecurityException("UPDATE_PACKAGE_FILE_COUNT_INVALID", "Desktop package must contain between 1 and the supported maximum number of files.");
        if (!files.Any(file => string.Equals(file.Path, normalizedEntryPoint, StringComparison.Ordinal)))
            throw new UpdateSecurityException("UPDATE_PACKAGE_ENTRYPOINT_MISSING", "Desktop package entry point does not exist in the source tree.");

        var manifest = new PackageManifest(PackageManifestSchema, version.ToString(), normalizedEntryPoint, files);
        var manifestBytes = JsonSerializer.SerializeToUtf8Bytes(manifest, JsonOptions);

        var outputDirectory = Path.GetDirectoryName(outputPath)
            ?? throw new UpdateSecurityException("UPDATE_PACKAGE_OUTPUT_INVALID", "Desktop package output directory is invalid.");
        Directory.CreateDirectory(outputDirectory);
        var tempPath = Path.Combine(outputDirectory, $".swir-package-{Guid.NewGuid():N}.tmp");

        try
        {
            using (var stream = new FileStream(tempPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
            using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: false))
            {
                WriteEntry(archive, ManifestEntryName, manifestBytes);
                foreach (var file in files)
                {
                    var fullPath = SafeChild(sourceRoot, file.Path.Replace('/', Path.DirectorySeparatorChar));
                    WriteFileEntry(archive, file.Path, fullPath);
                }
            }

            File.Move(tempPath, outputPath, true);
        }
        finally
        {
            try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch { }
        }

        string packageSha256;
        using (var stream = new FileStream(outputPath, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, FileOptions.SequentialScan))
            packageSha256 = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();

        return new PackageBuildResult(BuilderSchema, outputPath, version.ToString(), normalizedEntryPoint, files.Count, expandedBytes, packageSha256);
    }

    private static void WriteEntry(ZipArchive archive, string path, ReadOnlySpan<byte> content)
    {
        var entry = archive.CreateEntry(path, CompressionLevel.NoCompression);
        entry.LastWriteTime = DeterministicTimestamp;
        entry.ExternalAttributes = 0;
        using var output = entry.Open();
        output.Write(content);
    }

    private static void WriteFileEntry(ZipArchive archive, string relativePath, string fullPath)
    {
        var entry = archive.CreateEntry(relativePath, CompressionLevel.NoCompression);
        entry.LastWriteTime = DeterministicTimestamp;
        entry.ExternalAttributes = 0;
        using var input = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, FileOptions.SequentialScan);
        using var output = entry.Open();
        input.CopyTo(output, 128 * 1024);
    }

    private static string NormalizeRelativePath(string path) => (path ?? string.Empty).Replace('\\', '/').Trim('/');

    private static void ValidateRelativePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || Path.IsPathRooted(path) || path.Contains(':'))
            throw new UpdateSecurityException("UPDATE_PACKAGE_PATH_INVALID", "Desktop package contains an invalid relative path.");
        var parts = path.Split('/', StringSplitOptions.None);
        if (parts.Length == 0 || parts.Any(part => string.IsNullOrWhiteSpace(part) || part is "." or ".."))
            throw new UpdateSecurityException("UPDATE_PACKAGE_PATH_INVALID", "Desktop package path traversal is blocked.");
    }

    private static bool IsInside(string root, string candidate)
    {
        var canonicalRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var canonicalCandidate = Path.GetFullPath(candidate);
        return canonicalCandidate.StartsWith(canonicalRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || string.Equals(canonicalCandidate, canonicalRoot, StringComparison.OrdinalIgnoreCase);
    }

    private static string SafeChild(string root, string relativePath)
    {
        var canonicalRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var candidate = Path.GetFullPath(Path.Combine(canonicalRoot, relativePath));
        if (!candidate.StartsWith(canonicalRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new UpdateSecurityException("UPDATE_PACKAGE_PATH_ESCAPE", "Desktop package source path escaped the release root.");
        return candidate;
    }
}
