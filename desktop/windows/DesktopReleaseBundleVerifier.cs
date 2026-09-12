using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Swir.Desktop.Host;

internal static class DesktopReleaseBundleVerifier
{
    public const string VerifierSchema = "swir.desktop-release-bundle-verifier/0.1";
    private static readonly Regex Sha256Pattern = new("^[a-f0-9]{64}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    internal sealed record VerificationResult(
        string Schema,
        string Version,
        string Channel,
        string KeyId,
        string PackageFile,
        string PackageSha256,
        long PackageSize,
        string ManifestFile,
        string ManifestSha256,
        string PackageHost,
        DateTimeOffset PublishedAt);

    private sealed record BundleMetadata(
        string? Schema,
        string? Version,
        string? Channel,
        string? KeyId,
        string? PackageFile,
        string? PackageSha256,
        long PackageSize,
        string? ManifestFile,
        string? ManifestSha256,
        DateTimeOffset PublishedAt);

    public static VerificationResult Verify(
        string bundleDirectory,
        Version expectedVersion,
        string expectedChannel,
        string publicKeyPem,
        IEnumerable<string> allowedPackageHosts)
    {
        if (string.IsNullOrWhiteSpace(bundleDirectory))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_VERIFY_PATH_INVALID", "Release bundle directory is required.");
        if (expectedVersion is null || expectedVersion <= new Version(0, 0))
            throw new UpdateSecurityException("UPDATE_RELEASE_VERSION_INVALID", "Expected release version must be positive.");

        var channel = (expectedChannel ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(channel))
            throw new UpdateSecurityException("UPDATE_RELEASE_CHANNEL_INVALID", "Expected release channel is required.");

        ValidatePublicKey(publicKeyPem);
        var hosts = (allowedPackageHosts ?? Array.Empty<string>())
            .Where(host => !string.IsNullOrWhiteSpace(host))
            .Select(host => host.Trim().ToLowerInvariant())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (hosts.Length == 0)
            throw new UpdateSecurityException("UPDATE_HOST_POLICY_EMPTY", "At least one release package host must be allowed for verification.");

        var root = Path.GetFullPath(bundleDirectory)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (!Directory.Exists(root))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_VERIFY_PATH_MISSING", "Release bundle directory does not exist.");
        RejectReparsePoint(root, "UPDATE_RELEASE_BUNDLE_VERIFY_REPARSE_DENIED", "Release bundle directory must not be a reparse point.");

        var metadataPath = Path.Combine(root, "release-bundle.json");
        if (!File.Exists(metadataPath))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_METADATA_MISSING", "release-bundle.json is missing.");
        RejectReparsePoint(metadataPath, "UPDATE_RELEASE_BUNDLE_VERIFY_REPARSE_DENIED", "Release metadata must not be a reparse point.");

        BundleMetadata metadata;
        try
        {
            metadata = JsonSerializer.Deserialize<BundleMetadata>(File.ReadAllText(metadataPath), new JsonSerializerOptions { PropertyNameCaseInsensitive = false })
                ?? throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_METADATA_INVALID", "Release bundle metadata could not be decoded.");
        }
        catch (UpdateSecurityException) { throw; }
        catch (JsonException)
        {
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_METADATA_INVALID", "Release bundle metadata is invalid JSON.");
        }

        if (!string.Equals(metadata.Schema, DesktopReleaseBundleBuilder.BundleSchema, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_SCHEMA_UNSUPPORTED", "Release bundle schema is not supported.");
        if (!Version.TryParse(metadata.Version, out var metadataVersion) || metadataVersion != expectedVersion)
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_VERSION_MISMATCH", "Release bundle version does not match the expected version.");
        if (!string.Equals(metadata.Channel, channel, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_CHANNEL_MISMATCH", "Release bundle channel does not match the expected channel.");
        if (string.IsNullOrWhiteSpace(metadata.KeyId) || metadata.KeyId.Length > 128)
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_KEY_ID_INVALID", "Release bundle key id is invalid.");

        var expectedPackageFile = $"SWIR-Desktop-{expectedVersion}-{channel}.zip";
        var expectedManifestFile = $"desktop-update-{channel}.json";
        if (!string.Equals(metadata.PackageFile, expectedPackageFile, StringComparison.Ordinal)
            || !string.Equals(metadata.ManifestFile, expectedManifestFile, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_FILENAME_MISMATCH", "Release bundle filenames are not canonical for the expected version and channel.");
        if (!IsSha256(metadata.PackageSha256) || !IsSha256(metadata.ManifestSha256))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_HASH_INVALID", "Release bundle metadata contains an invalid SHA-256 value.");
        if (metadata.PackageSize is <= 0 or > UpdateBroker.MaxPackageBytes)
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_SIZE_INVALID", "Release bundle package size is outside the allowed range.");

        var packagePath = Path.Combine(root, expectedPackageFile);
        var manifestPath = Path.Combine(root, expectedManifestFile);
        if (!File.Exists(packagePath))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_PACKAGE_MISSING", "Release bundle package is missing.");
        if (!File.Exists(manifestPath))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_MANIFEST_MISSING", "Release bundle signed manifest is missing.");
        RejectReparsePoint(packagePath, "UPDATE_RELEASE_BUNDLE_VERIFY_REPARSE_DENIED", "Release package must not be a reparse point.");
        RejectReparsePoint(manifestPath, "UPDATE_RELEASE_BUNDLE_VERIFY_REPARSE_DENIED", "Release manifest must not be a reparse point.");

        var packageInfo = new FileInfo(packagePath);
        if (packageInfo.Length != metadata.PackageSize)
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_SIZE_MISMATCH", "Release package size does not match release-bundle.json.");
        var packageSha = HashFile(packagePath);
        if (!FixedTimeShaEquals(packageSha, metadata.PackageSha256!))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_PACKAGE_HASH_MISMATCH", "Release package SHA-256 does not match release-bundle.json.");
        var manifestSha = HashFile(manifestPath);
        if (!FixedTimeShaEquals(manifestSha, metadata.ManifestSha256!))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_MANIFEST_HASH_MISMATCH", "Signed manifest SHA-256 does not match release-bundle.json.");

        var broker = new UpdateBroker(publicKeyPem, hosts);
        var verified = broker.VerifyManifest(File.ReadAllText(manifestPath), new Version(0, 0), channel);
        if (verified.Version != expectedVersion)
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_SIGNED_VERSION_MISMATCH", "Signed manifest version does not match release-bundle.json.");
        if (!string.Equals(verified.KeyId, metadata.KeyId, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_SIGNED_KEY_ID_MISMATCH", "Signed manifest key id does not match release-bundle.json.");
        if (!FixedTimeShaEquals(verified.Sha256, metadata.PackageSha256!))
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_SIGNED_HASH_MISMATCH", "Signed package SHA-256 does not match release-bundle.json.");
        if (verified.Size != metadata.PackageSize)
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_SIGNED_SIZE_MISMATCH", "Signed package size does not match release-bundle.json.");
        if (verified.PublishedAt.ToUniversalTime() != metadata.PublishedAt.ToUniversalTime())
            throw new UpdateSecurityException("UPDATE_RELEASE_BUNDLE_SIGNED_TIMESTAMP_MISMATCH", "Signed publication time does not match release-bundle.json.");

        var packageBytes = File.ReadAllBytes(packagePath);
        UpdateBroker.VerifyPackage(packageBytes, verified);

        return new VerificationResult(
            VerifierSchema,
            expectedVersion.ToString(),
            channel,
            metadata.KeyId!,
            expectedPackageFile,
            packageSha,
            packageInfo.Length,
            expectedManifestFile,
            manifestSha,
            verified.PackageUri.Host,
            verified.PublishedAt.ToUniversalTime());
    }

    private static void ValidatePublicKey(string publicKeyPem)
    {
        if (string.IsNullOrWhiteSpace(publicKeyPem))
            throw new UpdateSecurityException("UPDATE_KEY_MISSING", "A release verification public key is required.");
        using var rsa = RSA.Create();
        try { rsa.ImportFromPem(publicKeyPem); }
        catch (Exception ex) when (ex is ArgumentException or CryptographicException)
        {
            throw new UpdateSecurityException("UPDATE_KEY_INVALID", "Release verification public key is invalid.");
        }
        if (rsa.KeySize < 2048)
            throw new UpdateSecurityException("UPDATE_KEY_TOO_SMALL", "Release verification RSA key must be at least 2048 bits.");
    }

    private static bool IsSha256(string? value)
        => Sha256Pattern.IsMatch((value ?? string.Empty).Trim().ToLowerInvariant());

    private static string HashFile(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, FileOptions.SequentialScan);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static bool FixedTimeShaEquals(string left, string right)
        => CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(left.ToLowerInvariant()),
            Encoding.ASCII.GetBytes(right.ToLowerInvariant()));

    private static void RejectReparsePoint(string path, string code, string message)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new UpdateSecurityException(code, message);
    }
}
