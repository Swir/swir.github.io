using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Swir.Desktop.Host;

internal static class DesktopReleaseBundleBuilder
{
    public const string BundleSchema = "swir.desktop-release-bundle/0.1";
    private static readonly Regex ChannelPattern = new("^[a-z0-9_-]{1,32}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    internal sealed record ReleaseBundleMetadata(
        string Schema,
        string Version,
        string Channel,
        string KeyId,
        string PackageFile,
        string PackageSha256,
        long PackageSize,
        string ManifestFile,
        string ManifestSha256,
        DateTimeOffset PublishedAt);

    internal sealed record ReleaseBundleResult(
        string Schema,
        string OutputDirectory,
        string PackagePath,
        string ManifestPath,
        string MetadataPath,
        string Version,
        string Channel,
        string PackageSha256,
        string ManifestSha256);

    public static ReleaseBundleResult Build(
        string sourceDirectory,
        string outputDirectory,
        Version version,
        string entryPoint,
        Uri packageUri,
        string channel,
        string keyId,
        string privateKeyPem,
        DateTimeOffset publishedAt)
    {
        if (string.IsNullOrWhiteSpace(sourceDirectory))
            throw new UpdateSecurityException("UPDATE_PACKAGE_SOURCE_INVALID", "Desktop package source directory is required.");
        if (string.IsNullOrWhiteSpace(outputDirectory))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_OUTPUT_INVALID", "A release bundle output directory is required.");
        if (version is null || version <= new Version(0, 0))
            throw new UpdateSecurityException("UPDATE_RELEASE_VERSION_INVALID", "A positive Desktop release version is required.");

        var normalizedChannel = (channel ?? string.Empty).Trim().ToLowerInvariant();
        if (!ChannelPattern.IsMatch(normalizedChannel))
            throw new UpdateSecurityException("UPDATE_RELEASE_CHANNEL_INVALID", "Release channel is invalid.");

        var sourceRoot = Path.GetFullPath(sourceDirectory)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var finalRoot = Path.GetFullPath(outputDirectory)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

        if (!Directory.Exists(sourceRoot))
            throw new UpdateSecurityException("UPDATE_PACKAGE_SOURCE_MISSING", "Desktop package source directory does not exist.");
        if (Directory.Exists(finalRoot) || File.Exists(finalRoot))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_OUTPUT_EXISTS", "Release bundle output path must not already exist.");
        if (IsInside(sourceRoot, finalRoot))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_OUTPUT_INVALID", "Release bundle output must be outside the package source tree.");

        var packageFileName = $"SWIR-Desktop-{version}-{normalizedChannel}.zip";
        if (packageUri is null || !packageUri.IsAbsoluteUri)
            throw new UpdateSecurityException("UPDATE_RELEASE_URL_INVALID", "Release package URL must be absolute.");
        var uriFileName = Uri.UnescapeDataString(Path.GetFileName(packageUri.AbsolutePath));
        if (!string.Equals(uriFileName, packageFileName, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_URL_MISMATCH", "Package URL filename must match the generated release package filename.");

        var parent = Path.GetDirectoryName(finalRoot)
            ?? throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_OUTPUT_INVALID", "Release bundle output parent directory is invalid.");
        Directory.CreateDirectory(parent);
        var stagingRoot = Path.Combine(parent, $".swir-release-{Guid.NewGuid():N}.tmp");

        try
        {
            Directory.CreateDirectory(stagingRoot);
            var packagePath = Path.Combine(stagingRoot, packageFileName);
            var manifestPath = Path.Combine(stagingRoot, $"desktop-update-{normalizedChannel}.json");
            var metadataPath = Path.Combine(stagingRoot, "release-bundle.json");

            var package = DesktopPackageBuilder.Build(sourceRoot, packagePath, version, entryPoint);
            var envelope = DesktopUpdateReleaseBuilder.BuildEnvelope(
                packagePath,
                packageUri,
                version,
                normalizedChannel,
                keyId,
                privateKeyPem,
                publishedAt);
            DesktopUpdateReleaseBuilder.WriteEnvelopeAtomic(manifestPath, envelope);

            var packageInfo = new FileInfo(packagePath);
            var manifestSha = HashFile(manifestPath);
            var metadata = new ReleaseBundleMetadata(
                BundleSchema,
                version.ToString(),
                normalizedChannel,
                keyId.Trim(),
                packageFileName,
                package.Sha256,
                packageInfo.Length,
                Path.GetFileName(manifestPath),
                manifestSha,
                publishedAt.ToUniversalTime());
            WriteJsonAtomic(metadataPath, metadata);

            Directory.Move(stagingRoot, finalRoot);

            return new ReleaseBundleResult(
                BundleSchema,
                finalRoot,
                Path.Combine(finalRoot, packageFileName),
                Path.Combine(finalRoot, Path.GetFileName(manifestPath)),
                Path.Combine(finalRoot, "release-bundle.json"),
                version.ToString(),
                normalizedChannel,
                package.Sha256,
                manifestSha);
        }
        catch
        {
            try { if (Directory.Exists(stagingRoot)) Directory.Delete(stagingRoot, true); } catch { }
            throw;
        }
    }

    private static string HashFile(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, FileOptions.SequentialScan);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static void WriteJsonAtomic<T>(string path, T value)
    {
        var directory = Path.GetDirectoryName(path)
            ?? throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_OUTPUT_INVALID", "Release metadata directory is invalid.");
        var temp = Path.Combine(directory, $".release-bundle-{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllBytes(temp, JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions));
            File.Move(temp, path, true);
        }
        finally
        {
            try { if (File.Exists(temp)) File.Delete(temp); } catch { }
        }
    }

    private static bool IsInside(string root, string candidate)
    {
        var canonicalRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var canonicalCandidate = Path.GetFullPath(candidate);
        return canonicalCandidate.StartsWith(canonicalRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || string.Equals(canonicalCandidate, canonicalRoot, StringComparison.OrdinalIgnoreCase);
    }
}
