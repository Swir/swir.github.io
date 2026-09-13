using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopCatalogTrustRootStore
{
    public const string Schema = "swir.catalog-trust-roots/1.0";
    private const string DefaultFileName = "catalog-trust-roots.json";

    internal sealed record LoadResult(string Source, IReadOnlyList<DesktopCatalogTrustVerifier.TrustRoot> Roots, bool RequireSignedCatalog);
    private sealed record RootDocument(string? Schema, RootRecord[]? Roots, bool RequireSignedCatalog = false);
    private sealed record RootRecord(string? KeyId, string? Name, string? Algorithm, string? Format, string? PublicKey, string[]? Scope, bool Enabled = true);

    public static LoadResult LoadProvisioned()
    {
        var configured = Environment.GetEnvironmentVariable("SWIR_CATALOG_TRUST_ROOTS");
        var path = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(AppContext.BaseDirectory, DefaultFileName)
            : Path.GetFullPath(configured);
        if (!File.Exists(path)) return new LoadResult(path, Array.Empty<DesktopCatalogTrustVerifier.TrustRoot>(), false);

        RootDocument? document;
        try { document = JsonSerializer.Deserialize<RootDocument>(File.ReadAllText(path), JsonOptions); }
        catch (Exception ex) { throw new DesktopPackageException("CATALOG_TRUST_ROOTS_INVALID", $"Catalog trust-root file is unreadable: {ex.Message}"); }
        if (document is null || !string.Equals(document.Schema, Schema, StringComparison.Ordinal))
            throw new DesktopPackageException("CATALOG_TRUST_ROOTS_INVALID", $"Catalog trust-root schema must be {Schema}.");

        var roots = new List<DesktopCatalogTrustVerifier.TrustRoot>();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var record in document.Roots ?? Array.Empty<RootRecord>())
        {
            if (!record.Enabled) continue;
            var keyId = (record.KeyId ?? string.Empty).Trim();
            if (keyId.Length is < 1 or > 128 || !ids.Add(keyId))
                throw new DesktopPackageException("CATALOG_TRUST_ROOTS_INVALID", "Enabled catalog trust roots require unique non-empty keyId values.");
            if (!string.Equals(record.Algorithm, "Ed25519", StringComparison.Ordinal) || !string.Equals(record.Format, "raw", StringComparison.OrdinalIgnoreCase))
                throw new DesktopPackageException("CATALOG_TRUST_ROOTS_INVALID", $"Catalog trust root {keyId} must use Ed25519 raw public keys.");
            byte[] publicKey;
            try { publicKey = Convert.FromBase64String((record.PublicKey ?? string.Empty).Trim()); }
            catch (FormatException) { throw new DesktopPackageException("CATALOG_TRUST_ROOTS_INVALID", $"Catalog trust root {keyId} publicKey is not base64."); }
            if (publicKey.Length != 32)
                throw new DesktopPackageException("CATALOG_TRUST_ROOTS_INVALID", $"Catalog trust root {keyId} must contain a 32-byte Ed25519 raw public key.");
            var scope = (record.Scope ?? Array.Empty<string>()).Select(x => x.Trim()).Where(x => x.Length > 0).Distinct(StringComparer.Ordinal).ToArray();
            if (!(scope.Contains("*", StringComparer.Ordinal) || scope.Contains("catalog:official", StringComparer.Ordinal)))
                throw new DesktopPackageException("CATALOG_TRUST_ROOTS_INVALID", $"Catalog trust root {keyId} must be scoped to catalog:official.");
            roots.Add(new DesktopCatalogTrustVerifier.TrustRoot(keyId, string.IsNullOrWhiteSpace(record.Name) ? keyId : record.Name.Trim(), publicKey, scope));
        }

        if (document.RequireSignedCatalog && roots.Count == 0)
            throw new DesktopPackageException(
                "CATALOG_TRUST_ROOT_REQUIRED",
                "This Desktop release requires signed package catalogs, but no enabled catalog:official trust root is provisioned.");

        return new LoadResult(path, roots, document.RequireSignedCatalog);
    }

    public static DesktopCatalogTrustVerifier? CreateVerifier(string dataRoot)
    {
        var loaded = LoadProvisioned();
        return loaded.Roots.Count == 0 ? null : new DesktopCatalogTrustVerifier(dataRoot, loaded.Roots);
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
}
