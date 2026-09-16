using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using NSec.Cryptography;

namespace Swir.Desktop.Host;

internal sealed class DesktopPackageSignatureVerifier
{
    public const string SignatureSchema = "swir.desktop-package-signature/1.0";
    private readonly IReadOnlyDictionary<string, TrustRoot> _roots;

    internal sealed record TrustRoot(string KeyId, string Name, byte[] PublicKey, IReadOnlyList<string> Scope);
    internal sealed record EnvelopeMetadata(string KeyId, string PackageId, string Version, string Sha256, string SignatureBase64);
    internal sealed record Authorization(string PackageId, string Version, string Sha256, string KeyId);

    public DesktopPackageSignatureVerifier(IEnumerable<TrustRoot> roots)
    {
        _roots = (roots ?? throw new ArgumentNullException(nameof(roots))).ToDictionary(x => x.KeyId, StringComparer.Ordinal);
    }

    public object Describe() => new
    {
        schema = SignatureSchema,
        provider = "desktop-native",
        algorithm = "Ed25519",
        digest = "SHA-256",
        failClosed = true,
        identityBound = true,
        trustedRoots = _roots.Count
    };

    public Authorization Verify(string bundlePath, string envelopeJson, string expectedPackageId, string expectedVersion)
    {
        if (!File.Exists(bundlePath))
            throw new DesktopPackageException("PACKAGE_NOT_FOUND", "SWIR package bundle does not exist.");

        var metadata = ReadMetadata(envelopeJson);
        if (!string.Equals(metadata.PackageId, expectedPackageId, StringComparison.Ordinal) ||
            !string.Equals(metadata.Version, expectedVersion, StringComparison.Ordinal))
        {
            throw new DesktopPackageException(
                "PACKAGE_SIGNATURE_IDENTITY_MISMATCH",
                $"Package signature targets {metadata.PackageId}@{metadata.Version}, but the selected .swirapp declares {expectedPackageId}@{expectedVersion}.");
        }

        var actual = ComputeSha256(bundlePath);
        if (!CryptographicOperations.FixedTimeEquals(Convert.FromHexString(metadata.Sha256), Convert.FromHexString(actual)))
            throw new DesktopPackageException("PACKAGE_SIGNATURE_HASH_MISMATCH", "Signed package SHA-256 does not match the selected .swirapp payload.");

        if (!_roots.TryGetValue(metadata.KeyId, out var root))
            throw new DesktopPackageException("PACKAGE_SIGNATURE_UNKNOWN_KEY", "Package signing key is not trusted by the Desktop Host.");
        if (!ScopeAllows(root!.Scope, metadata.PackageId))
            throw new DesktopPackageException("PACKAGE_SIGNATURE_KEY_OUT_OF_SCOPE", "Package signing key is outside the requested package scope.");

        byte[] signature;
        try { signature = Convert.FromBase64String(metadata.SignatureBase64); }
        catch (FormatException) { throw new DesktopPackageException("PACKAGE_SIGNATURE_INVALID", "Package signature is not valid base64."); }
        if (signature.Length != 64)
            throw new DesktopPackageException("PACKAGE_SIGNATURE_INVALID", "Ed25519 package signatures must be 64 bytes.");

        var algorithm = SignatureAlgorithm.Ed25519;
        PublicKey publicKey;
        try { publicKey = PublicKey.Import(algorithm, root.PublicKey, KeyBlobFormat.RawPublicKey); }
        catch (Exception ex) { throw new DesktopPackageException("PACKAGE_SIGNATURE_KEY_INVALID", $"Trusted package public key is invalid: {ex.Message}"); }

        var payload = BuildSignedPayload(metadata.KeyId, metadata.PackageId, metadata.Version, metadata.Sha256);
        if (!algorithm.Verify(publicKey, Encoding.UTF8.GetBytes(payload), signature))
            throw new DesktopPackageException("PACKAGE_SIGNATURE_BAD_SIGNATURE", "Cryptographic .swirapp signature verification failed.");

        return new Authorization(metadata.PackageId, metadata.Version, metadata.Sha256, metadata.KeyId);
    }

    internal static EnvelopeMetadata ReadMetadata(string envelopeJson)
    {
        if (string.IsNullOrWhiteSpace(envelopeJson))
            throw new DesktopPackageException("PACKAGE_SIGNATURE_REQUIRED", "A package signature envelope is required.");

        try
        {
            using var doc = JsonDocument.Parse(envelopeJson);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new DesktopPackageException("PACKAGE_SIGNATURE_INVALID", "Package signature envelope must be an object.");
            RequireString(root, "schema", SignatureSchema);
            RequireString(root, "algorithm", "Ed25519");
            var keyId = ValidateToken(GetRequiredString(root, "keyId"), "keyId", 128);
            var packageId = ValidatePackageId(GetRequiredString(root, "packageId"));
            var version = ValidateVersion(GetRequiredString(root, "version"));
            var sha256 = NormalizeDigest(GetRequiredString(root, "sha256"));
            var signature = GetRequiredString(root, "signature");
            try
            {
                if (Convert.FromBase64String(signature).Length != 64)
                    throw new DesktopPackageException("PACKAGE_SIGNATURE_INVALID", "Ed25519 package signatures must be 64 bytes.");
            }
            catch (FormatException)
            {
                throw new DesktopPackageException("PACKAGE_SIGNATURE_INVALID", "Package signature is not valid base64.");
            }
            return new EnvelopeMetadata(keyId, packageId, version, sha256, signature);
        }
        catch (DesktopPackageException) { throw; }
        catch (JsonException ex) { throw new DesktopPackageException("PACKAGE_SIGNATURE_INVALID", ex.Message); }
    }

    internal static string BuildSignedPayload(string keyId, string packageId, string version, string sha256) =>
        JsonSerializer.Serialize(new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["algorithm"] = "Ed25519",
            ["keyId"] = keyId,
            ["packageId"] = packageId,
            ["schema"] = SignatureSchema,
            ["sha256"] = NormalizeDigest(sha256),
            ["version"] = version
        });

    private static bool ScopeAllows(IReadOnlyList<string> scope, string packageId) =>
        scope.Contains("*", StringComparer.Ordinal) ||
        scope.Contains("package:*", StringComparer.Ordinal) ||
        scope.Contains("package:" + packageId, StringComparer.Ordinal);

    private static string ComputeSha256(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, FileOptions.SequentialScan);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static string NormalizeDigest(string value)
    {
        var digest = (value ?? string.Empty).Trim().ToLowerInvariant().Replace("sha256-", "").Replace("sha256:", "");
        if (digest.Length != 64 || digest.Any(ch => !Uri.IsHexDigit(ch)))
            throw new DesktopPackageException("PACKAGE_SIGNATURE_INVALID", "sha256 must be a 64-character hexadecimal SHA-256 digest.");
        return digest;
    }

    private static string ValidatePackageId(string value)
    {
        var id = value.Trim();
        if (id.Length is < 1 or > 128 || id.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '.' or '-' or '_')))
            throw new DesktopPackageException("PACKAGE_SIGNATURE_INVALID", "packageId contains unsupported characters.");
        return id;
    }

    private static string ValidateVersion(string value)
    {
        var version = value.Trim();
        if (version.Length is < 1 or > 64 || version.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '.' or '-' or '+' or '_')))
            throw new DesktopPackageException("PACKAGE_SIGNATURE_INVALID", "version contains unsupported characters.");
        return version;
    }

    private static string ValidateToken(string value, string field, int maxLength)
    {
        var token = value.Trim();
        if (token.Length is < 1 || token.Length > maxLength || token.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '.' or '-' or '_' or ':')))
            throw new DesktopPackageException("PACKAGE_SIGNATURE_INVALID", $"{field} contains unsupported characters.");
        return token;
    }

    private static string GetRequiredString(JsonElement node, string name) =>
        node.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()!
            : throw new DesktopPackageException("PACKAGE_SIGNATURE_INVALID", $"{name} is required.");

    private static void RequireString(JsonElement node, string name, string expected)
    {
        if (!string.Equals(GetRequiredString(node, name), expected, StringComparison.Ordinal))
            throw new DesktopPackageException("PACKAGE_SIGNATURE_INVALID", $"{name} must be {expected}.");
    }
}
