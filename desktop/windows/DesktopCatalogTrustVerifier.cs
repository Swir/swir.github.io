using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using NSec.Cryptography;

namespace Swir.Desktop.Host;

internal sealed class DesktopCatalogTrustVerifier
{
    public const string SignatureSchema = "swir.catalog-signature/1.0";
    public const string TrustStateSchema = "swir.catalog-trust-state/1.0";
    private static readonly TimeSpan DefaultClockSkew = TimeSpan.FromMinutes(5);
    private readonly string _statePath;
    private readonly IReadOnlyDictionary<string, TrustRoot> _roots;

    internal sealed record TrustRoot(string KeyId, string Name, byte[] PublicKey, IReadOnlyList<string> Scope);
    internal sealed record Authorization(string PackageId, string Version, string Sha256, string? ArtifactUrl, long Sequence, string CatalogVersion, string KeyId, DateTimeOffset ExpiresAt);
    private sealed record TrustState(string Schema, string CatalogId, string CatalogVersion, long Sequence, string CatalogSha256, string KeyId, string GeneratedAt, string ExpiresAt, string AcceptedAt);

    public DesktopCatalogTrustVerifier(string dataRoot, IEnumerable<TrustRoot> roots)
    {
        if (string.IsNullOrWhiteSpace(dataRoot)) throw new ArgumentException("Data root required.", nameof(dataRoot));
        _statePath = Path.Combine(dataRoot, "PackageTrust", "catalog-high-water.json");
        _roots = (roots ?? throw new ArgumentNullException(nameof(roots))).ToDictionary(x => x.KeyId, StringComparer.Ordinal);
    }

    public object Describe() => new
    {
        schema = SignatureSchema,
        provider = "desktop-native",
        algorithm = "Ed25519",
        failClosed = true,
        freshnessRequired = true,
        antiRollback = true,
        signedArtifactLocation = true,
        trustedRoots = _roots.Count,
        statePath = "PackageTrust/catalog-high-water.json"
    };

    public Authorization VerifyAndAuthorize(string catalogJson, string envelopeJson, string packageId, string version, DateTimeOffset? now = null)
    {
        using var catalogDoc = JsonDocument.Parse(catalogJson);
        using var envelopeDoc = JsonDocument.Parse(envelopeJson);
        if (catalogDoc.RootElement.ValueKind != JsonValueKind.Array) Fail("CATALOG_INVALID", "Catalog must be an array.");
        var envelope = envelopeDoc.RootElement;
        RequireString(envelope, "schema", SignatureSchema, "CATALOG_SIGNATURE_INVALID");
        RequireString(envelope, "catalogId", "official", "CATALOG_ID_MISMATCH");
        RequireString(envelope, "algorithm", "Ed25519", "CATALOG_SIGNATURE_INVALID");
        var keyId = GetRequiredString(envelope, "keyId", "CATALOG_SIGNATURE_INVALID");
        var catalogVersion = GetRequiredString(envelope, "catalogVersion", "CATALOG_SIGNATURE_INVALID");
        var expectedDigest = NormalizeDigest(GetRequiredString(envelope, "catalogSha256", "CATALOG_SIGNATURE_INVALID"));
        if (expectedDigest.Length != 64) Fail("CATALOG_SIGNATURE_INVALID", "catalogSha256 must be SHA-256 hex.");
        var sequence = GetPositiveSequence(envelope);
        var generatedAt = ParseInstant(GetRequiredString(envelope, "generatedAt", "CATALOG_SIGNATURE_INVALID"));
        var expiresAt = ParseInstant(GetRequiredString(envelope, "expiresAt", "CATALOG_SIGNATURE_INVALID"));
        if (expiresAt <= generatedAt) Fail("CATALOG_SIGNATURE_INVALID", "expiresAt must be after generatedAt.");
        var clock = now ?? DateTimeOffset.UtcNow;
        if (generatedAt > clock + DefaultClockSkew) Fail("CATALOG_FUTURE_METADATA", "Catalog metadata is dated too far in the future.");
        if (expiresAt < clock - DefaultClockSkew) Fail("CATALOG_EXPIRED", "Catalog metadata has expired.");

        var canonicalCatalog = CanonicalCatalog(catalogDoc.RootElement);
        var actualDigest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalCatalog))).ToLowerInvariant();
        if (!CryptographicOperations.FixedTimeEquals(Convert.FromHexString(expectedDigest), Convert.FromHexString(actualDigest)))
            Fail("CATALOG_DIGEST_MISMATCH", "Signed catalog digest mismatch.");

        if (!_roots.TryGetValue(keyId, out var root)) Fail("CATALOG_UNKNOWN_KEY", "Catalog signing key is not trusted by the Desktop Host.");
        if (!(root!.Scope.Contains("*") || root.Scope.Contains("catalog:official"))) Fail("CATALOG_KEY_OUT_OF_SCOPE", "Catalog signing key is outside catalog:official scope.");
        var signature = Convert.FromBase64String(GetRequiredString(envelope, "signature", "CATALOG_SIGNATURE_INVALID"));
        var signedPayload = CanonicalObject(new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["catalogId"] = "official",
            ["catalogSha256"] = expectedDigest,
            ["catalogVersion"] = catalogVersion,
            ["expiresAt"] = envelope.GetProperty("expiresAt").GetString(),
            ["generatedAt"] = envelope.GetProperty("generatedAt").GetString(),
            ["schema"] = SignatureSchema,
            ["sequence"] = sequence
        });
        var algorithm = SignatureAlgorithm.Ed25519;
        PublicKey publicKey;
        try { publicKey = PublicKey.Import(algorithm, root.PublicKey, KeyBlobFormat.RawPublicKey); }
        catch (Exception ex) { throw new DesktopPackageException("CATALOG_KEY_INVALID", $"Trusted catalog public key is invalid: {ex.Message}"); }
        if (!algorithm.Verify(publicKey, Encoding.UTF8.GetBytes(signedPayload), signature))
            Fail("CATALOG_BAD_SIGNATURE", "Cryptographic catalog signature verification failed.");

        var previous = ReadState();
        if (previous is not null)
        {
            if (sequence < previous.Sequence) Fail("CATALOG_ROLLBACK_DETECTED", "Catalog sequence is older than the native trusted high-water mark.");
            if (sequence == previous.Sequence && !string.Equals(expectedDigest, previous.CatalogSha256, StringComparison.OrdinalIgnoreCase))
                Fail("CATALOG_EQUIVOCATION_DETECTED", "Catalog sequence was reused with different signed content.");
        }

        var package = catalogDoc.RootElement.EnumerateArray().FirstOrDefault(x =>
            string.Equals(PackageId(x), packageId, StringComparison.Ordinal) &&
            string.Equals(OptionalString(x, "version"), version, StringComparison.Ordinal));
        if (package.ValueKind == JsonValueKind.Undefined) Fail("CATALOG_PACKAGE_NOT_FOUND", "Requested package/version is not present in the verified catalog.");
        var sha256 = PackageSha256(package);
        if (sha256.Length != 64) Fail("CATALOG_ARTIFACT_UNTRUSTED", "Verified catalog entry does not contain a Desktop artifact SHA-256.");
        var artifactUrl = PackageArtifactUrl(package);
        if (artifactUrl is not null && !IsSafeDesktopArtifactUrl(artifactUrl))
            Fail("CATALOG_ARTIFACT_URL_INVALID", "Verified catalog Desktop artifact URL must be a release-local packages/<name>.swirapp path.");

        WriteState(new TrustState(TrustStateSchema, "official", catalogVersion, sequence, expectedDigest, keyId,
            generatedAt.ToString("O"), expiresAt.ToString("O"), clock.ToString("O")));
        return new Authorization(packageId, version, sha256, artifactUrl, sequence, catalogVersion, keyId, expiresAt);
    }

    private TrustState? ReadState()
    {
        try
        {
            if (!File.Exists(_statePath)) return null;
            var state = JsonSerializer.Deserialize<TrustState>(File.ReadAllText(_statePath));
            return state?.Schema == TrustStateSchema && state.Sequence > 0 ? state : null;
        }
        catch { Fail("CATALOG_TRUST_STATE_INVALID", "Native catalog trust high-water state is unreadable."); return null; }
    }

    private void WriteState(TrustState state)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_statePath)!);
        var tmp = _statePath + ".tmp-" + Guid.NewGuid().ToString("N");
        File.WriteAllText(tmp, JsonSerializer.Serialize(state));
        File.Move(tmp, _statePath, true);
    }

    private static string CanonicalCatalog(JsonElement array)
    {
        var items = array.EnumerateArray().Select(x => x.Clone()).OrderBy(PackageId, StringComparer.Ordinal).ThenBy(x => OptionalString(x, "version"), StringComparer.Ordinal);
        return "[" + string.Join(",", items.Select(CanonicalElement)) + "]";
    }
    private static string CanonicalElement(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => "{" + string.Join(",", value.EnumerateObject().OrderBy(x => x.Name, StringComparer.Ordinal).Select(x => JsonSerializer.Serialize(x.Name) + ":" + CanonicalElement(x.Value))) + "}",
        JsonValueKind.Array => "[" + string.Join(",", value.EnumerateArray().Select(CanonicalElement)) + "]",
        JsonValueKind.String => JsonSerializer.Serialize(value.GetString()),
        JsonValueKind.Number => value.GetRawText(),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        _ => "null"
    };
    private static string CanonicalObject(SortedDictionary<string, object?> value) => JsonSerializer.Serialize(value);
    private static string PackageId(JsonElement item) => OptionalString(item, "packageId") ?? OptionalString(item, "id") ?? string.Empty;
    private static string PackageSha256(JsonElement item)
    {
        if (item.TryGetProperty("artifacts", out var artifacts) && artifacts.ValueKind == JsonValueKind.Object && artifacts.TryGetProperty("desktop", out var desktop) && desktop.ValueKind == JsonValueKind.Object)
            return NormalizeDigest(OptionalString(desktop, "sha256") ?? string.Empty);
        return NormalizeDigest(OptionalString(item, "packageSha256") ?? string.Empty);
    }
    private static string? PackageArtifactUrl(JsonElement item)
    {
        if (item.TryGetProperty("artifacts", out var artifacts) && artifacts.ValueKind == JsonValueKind.Object && artifacts.TryGetProperty("desktop", out var desktop) && desktop.ValueKind == JsonValueKind.Object)
        {
            var value = OptionalString(desktop, "url")?.Trim();
            return string.IsNullOrWhiteSpace(value) ? null : value.Replace('\\', '/');
        }
        return null;
    }
    internal static bool IsSafeDesktopArtifactUrl(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 240) return false;
        var normalized = value.Replace('\\', '/');
        if (!normalized.StartsWith("packages/", StringComparison.Ordinal)) return false;
        if (normalized.Contains("//", StringComparison.Ordinal) || normalized.Contains("../", StringComparison.Ordinal) || normalized.Contains("./", StringComparison.Ordinal)) return false;
        var fileName = normalized["packages/".Length..];
        if (string.IsNullOrWhiteSpace(fileName) || fileName.Contains('/')) return false;
        if (!fileName.EndsWith(".swirapp", StringComparison.OrdinalIgnoreCase)) return false;
        return fileName.All(ch => char.IsLetterOrDigit(ch) || ch is '.' or '_' or '-');
    }
    private static string? OptionalString(JsonElement node, string name) => node.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static string GetRequiredString(JsonElement node, string name, string code) => OptionalString(node, name) is { Length: > 0 } value ? value : throw new DesktopPackageException(code, $"{name} required.");
    private static long GetPositiveSequence(JsonElement node)
    {
        if (!node.TryGetProperty("sequence", out var value) || !value.TryGetInt64(out var sequence) || sequence < 1)
            throw new DesktopPackageException("CATALOG_SIGNATURE_INVALID", "Positive integer sequence required.");
        return sequence;
    }
    private static void RequireString(JsonElement node, string name, string expected, string code) { if (!string.Equals(OptionalString(node, name), expected, StringComparison.Ordinal)) Fail(code, $"{name} must be {expected}."); }
    private static string NormalizeDigest(string value) => value.Trim().ToLowerInvariant().Replace("sha256-", "").Replace("sha256:", "");
    private static DateTimeOffset ParseInstant(string value) { if (!DateTimeOffset.TryParse(value, out var parsed) || !value.EndsWith('Z')) Fail("CATALOG_SIGNATURE_INVALID", "Catalog timestamps must be ISO UTC instants."); return parsed.ToUniversalTime(); }
    private static void Fail(string code, string message) => throw new DesktopPackageException(code, message);
}