using System.Text.Json;

namespace Swir.Desktop.Host;

internal static class DesktopPackageTrustRootStore
{
    public const string Schema = "swir.package-trust-roots/1.0";
    private const string DefaultFileName = "package-trust-roots.json";

    internal sealed record LoadResult(string Source, IReadOnlyList<DesktopPackageSignatureVerifier.TrustRoot> Roots, bool RequireSignedPackages);
    private sealed record RootDocument(string? Schema, RootRecord[]? Roots, bool RequireSignedPackages = false);
    private sealed record RootRecord(string? KeyId, string? Name, string? Algorithm, string? Format, string? PublicKey, string[]? Scope, bool Enabled = true);

    public static LoadResult LoadProvisioned()
    {
        var configured = Environment.GetEnvironmentVariable("SWIR_PACKAGE_TRUST_ROOTS");
        var path = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(AppContext.BaseDirectory, DefaultFileName)
            : Path.GetFullPath(configured);
        if (!File.Exists(path)) return new LoadResult(path, Array.Empty<DesktopPackageSignatureVerifier.TrustRoot>(), false);

        RootDocument? document;
        try { document = JsonSerializer.Deserialize<RootDocument>(File.ReadAllText(path), JsonOptions); }
        catch (Exception ex) { throw new DesktopPackageException("PACKAGE_TRUST_ROOTS_INVALID", $"Package trust-root file is unreadable: {ex.Message}"); }
        if (document is null || !string.Equals(document.Schema, Schema, StringComparison.Ordinal))
            throw new DesktopPackageException("PACKAGE_TRUST_ROOTS_INVALID", $"Package trust-root schema must be {Schema}.");

        var roots = new List<DesktopPackageSignatureVerifier.TrustRoot>();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var record in document.Roots ?? Array.Empty<RootRecord>())
        {
            if (!record.Enabled) continue;
            var keyId = (record.KeyId ?? string.Empty).Trim();
            if (keyId.Length is < 1 or > 128 || !ids.Add(keyId))
                throw new DesktopPackageException("PACKAGE_TRUST_ROOTS_INVALID", "Enabled package trust roots require unique non-empty keyId values.");
            if (!string.Equals(record.Algorithm, "Ed25519", StringComparison.Ordinal) || !string.Equals(record.Format, "raw", StringComparison.OrdinalIgnoreCase))
                throw new DesktopPackageException("PACKAGE_TRUST_ROOTS_INVALID", $"Package trust root {keyId} must use Ed25519 raw public keys.");

            byte[] publicKey;
            try { publicKey = Convert.FromBase64String((record.PublicKey ?? string.Empty).Trim()); }
            catch (FormatException) { throw new DesktopPackageException("PACKAGE_TRUST_ROOTS_INVALID", $"Package trust root {keyId} publicKey is not base64."); }
            if (publicKey.Length != 32)
                throw new DesktopPackageException("PACKAGE_TRUST_ROOTS_INVALID", $"Package trust root {keyId} must contain a 32-byte Ed25519 raw public key.");

            var scope = (record.Scope ?? Array.Empty<string>())
                .Select(x => x.Trim())
                .Where(x => x.Length > 0)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (scope.Length == 0 || scope.Any(x => x != "*" && x != "package:*" && !IsPackageScope(x)))
                throw new DesktopPackageException("PACKAGE_TRUST_ROOTS_INVALID", $"Package trust root {keyId} contains an invalid package scope.");

            roots.Add(new DesktopPackageSignatureVerifier.TrustRoot(
                keyId,
                string.IsNullOrWhiteSpace(record.Name) ? keyId : record.Name.Trim(),
                publicKey,
                scope));
        }

        if (document.RequireSignedPackages && roots.Count == 0)
            throw new DesktopPackageException(
                "PACKAGE_TRUST_ROOT_REQUIRED",
                "This Desktop release requires signed .swirapp packages, but no enabled package trust root is provisioned.");

        return new LoadResult(path, roots, document.RequireSignedPackages);
    }

    public static DesktopPackageSignatureVerifier? CreateVerifier()
    {
        var loaded = LoadProvisioned();
        return loaded.Roots.Count == 0 ? null : new DesktopPackageSignatureVerifier(loaded.Roots);
    }

    private static bool IsPackageScope(string value)
    {
        if (!value.StartsWith("package:", StringComparison.Ordinal) || value.Length <= "package:".Length) return false;
        var id = value["package:".Length..];
        return id.Length <= 128 && id.All(ch => char.IsLetterOrDigit(ch) || ch is '.' or '-' or '_');
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
}
