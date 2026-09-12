using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Swir.Desktop.Host;

internal static class DesktopUpdateReleaseBuilder
{
    public const string BuilderSchema = "swir.desktop-release-builder/0.1";
    private static readonly Regex ChannelPattern = new("^[a-z0-9_-]{1,32}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public static string BuildEnvelope(
        string packagePath,
        Uri packageUri,
        Version version,
        string channel,
        string keyId,
        string privateKeyPem,
        DateTimeOffset publishedAt)
    {
        if (string.IsNullOrWhiteSpace(packagePath))
            throw new UpdateSecurityException("UPDATE_RELEASE_PACKAGE_PATH_INVALID", "A release package path is required.");
        var fullPackagePath = Path.GetFullPath(packagePath);
        if (!File.Exists(fullPackagePath))
            throw new UpdateSecurityException("UPDATE_RELEASE_PACKAGE_MISSING", "The release package does not exist.");
        if (packageUri is null
            || !packageUri.IsAbsoluteUri
            || !string.Equals(packageUri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || !packageUri.IsDefaultPort
            || !string.IsNullOrEmpty(packageUri.UserInfo)
            || !string.IsNullOrEmpty(packageUri.Fragment))
            throw new UpdateSecurityException("UPDATE_RELEASE_URL_INVALID", "Release package URL must be a canonical HTTPS URL.");
        if (version is null || version <= new Version(0, 0))
            throw new UpdateSecurityException("UPDATE_RELEASE_VERSION_INVALID", "A positive Desktop release version is required.");

        var normalizedChannel = (channel ?? string.Empty).Trim().ToLowerInvariant();
        if (!ChannelPattern.IsMatch(normalizedChannel))
            throw new UpdateSecurityException("UPDATE_RELEASE_CHANNEL_INVALID", "Release channel is invalid.");
        var normalizedKeyId = (keyId ?? string.Empty).Trim();
        if (normalizedKeyId.Length is < 1 or > 128)
            throw new UpdateSecurityException("UPDATE_RELEASE_KEY_ID_INVALID", "Release key id must contain between 1 and 128 characters.");
        if (publishedAt == default || publishedAt > DateTimeOffset.UtcNow.AddHours(24))
            throw new UpdateSecurityException("UPDATE_RELEASE_TIMESTAMP_INVALID", "Release publication timestamp is invalid.");
        if (string.IsNullOrWhiteSpace(privateKeyPem))
            throw new UpdateSecurityException("UPDATE_RELEASE_PRIVATE_KEY_MISSING", "A release signing private key is required.");

        var info = new FileInfo(fullPackagePath);
        if (info.Length is <= 0 or > UpdateBroker.MaxPackageBytes)
            throw new UpdateSecurityException("UPDATE_RELEASE_PACKAGE_SIZE_INVALID", "Release package size is outside the supported range.");

        string sha256;
        using (var stream = new FileStream(fullPackagePath, FileMode.Open, FileAccess.Read, FileShare.Read))
            sha256 = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();

        var payloadBytes = JsonSerializer.SerializeToUtf8Bytes(new
        {
            Schema = UpdateBroker.PayloadSchema,
            Version = version.ToString(),
            Channel = normalizedChannel,
            PublishedAt = publishedAt,
            Package = new
            {
                Url = packageUri.AbsoluteUri,
                Sha256 = sha256,
                Size = info.Length
            }
        });

        byte[] signature;
        using (var rsa = RSA.Create())
        {
            try
            {
                rsa.ImportFromPem(privateKeyPem);
                if (rsa.KeySize < 2048)
                    throw new UpdateSecurityException("UPDATE_RELEASE_PRIVATE_KEY_INVALID", "Release signing RSA key must be at least 2048 bits.");
                signature = rsa.SignData(payloadBytes, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
            }
            catch (UpdateSecurityException) { throw; }
            catch (Exception ex) when (ex is ArgumentException or CryptographicException)
            {
                throw new UpdateSecurityException("UPDATE_RELEASE_PRIVATE_KEY_INVALID", "Release signing private key is invalid or cannot sign data.");
            }
        }

        return JsonSerializer.Serialize(new
        {
            Schema = UpdateBroker.EnvelopeSchema,
            Algorithm = UpdateBroker.SignatureAlgorithm,
            KeyId = normalizedKeyId,
            Payload = Convert.ToBase64String(payloadBytes),
            Signature = Convert.ToBase64String(signature)
        });
    }

    public static void WriteEnvelopeAtomic(string outputPath, string envelopeJson)
    {
        if (string.IsNullOrWhiteSpace(outputPath))
            throw new UpdateSecurityException("UPDATE_RELEASE_OUTPUT_PATH_INVALID", "A release manifest output path is required.");
        if (string.IsNullOrWhiteSpace(envelopeJson))
            throw new UpdateSecurityException("UPDATE_RELEASE_ENVELOPE_EMPTY", "Release envelope is empty.");

        var fullPath = Path.GetFullPath(outputPath);
        var directory = Path.GetDirectoryName(fullPath) ?? throw new UpdateSecurityException("UPDATE_RELEASE_OUTPUT_PATH_INVALID", "Release manifest output directory is invalid.");
        Directory.CreateDirectory(directory);
        var tempPath = fullPath + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllText(tempPath, envelopeJson);
            File.Move(tempPath, fullPath, true);
        }
        finally
        {
            if (File.Exists(tempPath)) File.Delete(tempPath);
        }
    }
}