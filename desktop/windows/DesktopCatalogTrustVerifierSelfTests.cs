using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using NSec.Cryptography;

namespace Swir.Desktop.Host;

internal static class DesktopCatalogTrustVerifierSelfTests
{
    public static int Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "swir-catalog-trust-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var algorithm = SignatureAlgorithm.Ed25519;
            using var signingKey = new Key(algorithm, new KeyCreationParameters { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });
            var publicKey = signingKey.PublicKey.Export(KeyBlobFormat.RawPublicKey);
            var trust = new DesktopCatalogTrustVerifier.TrustRoot("test-release", "SWIR Test Release", publicKey, new[] { "catalog:official" });
            var verifier = new DesktopCatalogTrustVerifier(root, new[] { trust });
            var packageHash = new string('a', 64);
            var catalog = JsonSerializer.Serialize(new object[]
            {
                new { schema="swir.app/1.0", id="demo", packageId="swir.demo", version="1.0.0", artifacts=new { desktop=new { sha256=packageHash } } }
            });
            var now = new DateTimeOffset(2026, 9, 13, 8, 0, 0, TimeSpan.Zero);
            var envelope = Envelope(signingKey, catalog, 41, packageHash, now.AddMinutes(-1), now.AddHours(1));

            var auth = verifier.VerifyAndAuthorize(catalog, envelope, "swir.demo", "1.0.0", now);
            Require(auth.Sha256 == packageHash, "authorized digest mismatch");
            Require(auth.Sequence == 41, "authorized sequence mismatch");

            ExpectCode(() => verifier.VerifyAndAuthorize(catalog, Tamper(envelope, "signature", Convert.ToBase64String(new byte[64])), "swir.demo", "1.0.0", now), "CATALOG_BAD_SIGNATURE");
            ExpectCode(() => verifier.VerifyAndAuthorize(catalog, Envelope(signingKey, catalog, 40, packageHash, now.AddMinutes(-1), now.AddHours(1)), "swir.demo", "1.0.0", now), "CATALOG_ROLLBACK_DETECTED");

            var catalog42 = JsonSerializer.Serialize(new object[]
            {
                new { schema="swir.app/1.0", id="demo", packageId="swir.demo", version="1.1.0", artifacts=new { desktop=new { sha256=new string('b',64) } } }
            });
            var env42 = Envelope(signingKey, catalog42, 42, new string('b',64), now, now.AddHours(1));
            var auth42 = verifier.VerifyAndAuthorize(catalog42, env42, "swir.demo", "1.1.0", now.AddMinutes(1));
            Require(auth42.Sequence == 42, "sequence 42 should advance native high-water mark");
            ExpectCode(() => verifier.VerifyAndAuthorize(catalog, envelope, "swir.demo", "1.0.0", now.AddMinutes(2)), "CATALOG_ROLLBACK_DETECTED");

            var missingArtifactCatalog = JsonSerializer.Serialize(new object[] { new { id="demo", packageId="swir.nohash", version="1.0.0" } });
            var missingEnv = Envelope(signingKey, missingArtifactCatalog, 43, "", now, now.AddHours(1));
            ExpectCode(() => verifier.VerifyAndAuthorize(missingArtifactCatalog, missingEnv, "swir.nohash", "1.0.0", now.AddMinutes(2)), "CATALOG_ARTIFACT_UNTRUSTED");

            var expiredEnv = Envelope(signingKey, catalog42, 44, new string('b',64), now.AddHours(-2), now.AddHours(-1));
            ExpectCode(() => verifier.VerifyAndAuthorize(catalog42, expiredEnv, "swir.demo", "1.1.0", now), "CATALOG_EXPIRED");

            var unknownVerifier = new DesktopCatalogTrustVerifier(Path.Combine(root, "unknown"), Array.Empty<DesktopCatalogTrustVerifier.TrustRoot>());
            ExpectCode(() => unknownVerifier.VerifyAndAuthorize(catalog, envelope, "swir.demo", "1.0.0", now), "CATALOG_UNKNOWN_KEY");

            Console.WriteLine("Desktop native catalog trust verifier self-tests passed.");
            return 0;
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }

    private static string Envelope(Key signingKey, string catalogJson, long sequence, string ignored, DateTimeOffset generatedAt, DateTimeOffset expiresAt)
    {
        using var doc = JsonDocument.Parse(catalogJson);
        var canonicalCatalog = CanonicalCatalog(doc.RootElement);
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalCatalog))).ToLowerInvariant();
        var payload = JsonSerializer.Serialize(new SortedDictionary<string, object?>(StringComparer.Ordinal)
        {
            ["catalogId"]="official", ["catalogSha256"]=digest, ["catalogVersion"]=$"2026.09.13.{sequence}",
            ["expiresAt"]=expiresAt.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"), ["generatedAt"]=generatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"),
            ["schema"]=DesktopCatalogTrustVerifier.SignatureSchema, ["sequence"]=sequence
        });
        var signature = SignatureAlgorithm.Ed25519.Sign(signingKey, Encoding.UTF8.GetBytes(payload));
        return JsonSerializer.Serialize(new
        {
            schema=DesktopCatalogTrustVerifier.SignatureSchema, catalogId="official", catalogVersion=$"2026.09.13.{sequence}", sequence,
            generatedAt=generatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"), expiresAt=expiresAt.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"),
            algorithm="Ed25519", keyId="test-release", catalogSha256=digest, signature=Convert.ToBase64String(signature)
        });
    }

    private static string Tamper(string json, string property, string value)
    {
        using var doc = JsonDocument.Parse(json);
        var map = doc.RootElement.EnumerateObject().ToDictionary(x => x.Name, x => x.Value.Clone());
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output))
        {
            writer.WriteStartObject();
            foreach (var pair in map)
            {
                writer.WritePropertyName(pair.Key);
                if (pair.Key == property) writer.WriteStringValue(value); else pair.Value.WriteTo(writer);
            }
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(output.ToArray());
    }

    private static string CanonicalCatalog(JsonElement array)
    {
        var items = array.EnumerateArray().Select(x=>x.Clone()).OrderBy(x=>S(x,"packageId")??S(x,"id")??string.Empty,StringComparer.Ordinal).ThenBy(x=>S(x,"version")??string.Empty,StringComparer.Ordinal);
        return "["+string.Join(",",items.Select(C))+ "]";
    }
    private static string C(JsonElement v)=>v.ValueKind switch
    {
        JsonValueKind.Object=>"{"+string.Join(",",v.EnumerateObject().OrderBy(x=>x.Name,StringComparer.Ordinal).Select(x=>JsonSerializer.Serialize(x.Name)+":"+C(x.Value)))+"}",
        JsonValueKind.Array=>"["+string.Join(",",v.EnumerateArray().Select(C))+"]",
        JsonValueKind.String=>JsonSerializer.Serialize(v.GetString()), JsonValueKind.Number=>v.GetRawText(), JsonValueKind.True=>"true", JsonValueKind.False=>"false", _=>"null"
    };
    private static string? S(JsonElement e,string n)=>e.TryGetProperty(n,out var v)&&v.ValueKind==JsonValueKind.String?v.GetString():null;
    private static void ExpectCode(Action action,string code){try{action();throw new Exception($"Expected {code}.");}catch(DesktopPackageException ex) when(ex.Code==code){}}
    private static void Require(bool condition,string message){if(!condition)throw new Exception(message);}
}
