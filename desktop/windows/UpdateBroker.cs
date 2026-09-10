using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Swir.Desktop.Host;

internal sealed class UpdateBroker
{
    public const string EnvelopeSchema = "swir.update-envelope/0.1";
    public const string PayloadSchema = "swir.desktop-update/0.1";
    public const string SignatureAlgorithm = "RSA-PSS-SHA256";
    public const long MaxPackageBytes = 512L * 1024L * 1024L;

    private static readonly Regex Sha256Pattern = new("^[a-f0-9]{64}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private readonly string _publicKeyPem;
    private readonly HashSet<string> _allowedPackageHosts;

    public UpdateBroker(string publicKeyPem, IEnumerable<string> allowedPackageHosts)
    {
        if (string.IsNullOrWhiteSpace(publicKeyPem)) throw new UpdateSecurityException("UPDATE_KEY_MISSING", "A release verification public key is required.");
        _publicKeyPem = publicKeyPem;
        _allowedPackageHosts = new HashSet<string>(allowedPackageHosts ?? Array.Empty<string>(), StringComparer.OrdinalIgnoreCase);
        if (_allowedPackageHosts.Count == 0) throw new UpdateSecurityException("UPDATE_HOST_POLICY_EMPTY", "At least one update package host must be explicitly allowed.");
    }

    public VerifiedUpdate VerifyManifest(string envelopeJson, Version currentVersion, string expectedChannel)
    {
        if (string.IsNullOrWhiteSpace(envelopeJson)) throw new UpdateSecurityException("UPDATE_MANIFEST_EMPTY", "Update manifest is empty.");
        if (currentVersion is null) throw new ArgumentNullException(nameof(currentVersion));
        if (string.IsNullOrWhiteSpace(expectedChannel)) throw new UpdateSecurityException("UPDATE_CHANNEL_INVALID", "Expected update channel is required.");

        UpdateEnvelope envelope;
        try
        {
            envelope = JsonSerializer.Deserialize<UpdateEnvelope>(envelopeJson, JsonOptions)
                ?? throw new UpdateSecurityException("UPDATE_MANIFEST_INVALID", "Update envelope could not be decoded.");
        }
        catch (UpdateSecurityException) { throw; }
        catch (Exception ex) when (ex is JsonException or FormatException)
        {
            throw new UpdateSecurityException("UPDATE_MANIFEST_INVALID", "Update envelope is invalid JSON.");
        }

        if (!string.Equals(envelope.Schema, EnvelopeSchema, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_SCHEMA_UNSUPPORTED", "Update envelope schema is not supported.");
        if (!string.Equals(envelope.Algorithm, SignatureAlgorithm, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_SIGNATURE_ALGORITHM_UNSUPPORTED", "Update signature algorithm is not supported.");
        if (string.IsNullOrWhiteSpace(envelope.KeyId) || envelope.KeyId.Length > 128)
            throw new UpdateSecurityException("UPDATE_KEY_ID_INVALID", "Update key id is invalid.");

        byte[] payloadBytes;
        byte[] signatureBytes;
        try
        {
            payloadBytes = Convert.FromBase64String(envelope.Payload ?? string.Empty);
            signatureBytes = Convert.FromBase64String(envelope.Signature ?? string.Empty);
        }
        catch (FormatException)
        {
            throw new UpdateSecurityException("UPDATE_SIGNATURE_FORMAT_INVALID", "Update payload or signature is not valid base64.");
        }
        if (payloadBytes.Length is < 2 or > 128 * 1024)
            throw new UpdateSecurityException("UPDATE_PAYLOAD_SIZE_INVALID", "Signed update payload size is outside the allowed range.");

        using var rsa = RSA.Create();
        try { rsa.ImportFromPem(_publicKeyPem); }
        catch (Exception ex) when (ex is ArgumentException or CryptographicException)
        {
            throw new UpdateSecurityException("UPDATE_KEY_INVALID", "Release verification public key is invalid.");
        }
        if (!rsa.VerifyData(payloadBytes, signatureBytes, HashAlgorithmName.SHA256, RSASignaturePadding.Pss))
            throw new UpdateSecurityException("UPDATE_SIGNATURE_INVALID", "Update signature verification failed.");

        UpdatePayload payload;
        try
        {
            payload = JsonSerializer.Deserialize<UpdatePayload>(payloadBytes, JsonOptions)
                ?? throw new UpdateSecurityException("UPDATE_PAYLOAD_INVALID", "Signed update payload could not be decoded.");
        }
        catch (UpdateSecurityException) { throw; }
        catch (JsonException)
        {
            throw new UpdateSecurityException("UPDATE_PAYLOAD_INVALID", "Signed update payload is invalid JSON.");
        }

        if (!string.Equals(payload.Schema, PayloadSchema, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_PAYLOAD_SCHEMA_UNSUPPORTED", "Signed update payload schema is not supported.");
        if (!string.Equals(payload.Channel, expectedChannel, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_CHANNEL_MISMATCH", "Update manifest does not match the configured release channel.");
        if (!Version.TryParse(payload.Version, out var candidateVersion))
            throw new UpdateSecurityException("UPDATE_VERSION_INVALID", "Update version is invalid.");
        if (candidateVersion <= currentVersion)
            throw new UpdateSecurityException("UPDATE_DOWNGRADE_BLOCKED", "Update version must be newer than the installed Desktop Host version.");
        if (payload.PublishedAt == default || payload.PublishedAt > DateTimeOffset.UtcNow.AddHours(24))
            throw new UpdateSecurityException("UPDATE_TIMESTAMP_INVALID", "Update publication timestamp is invalid.");
        if (payload.Package is null)
            throw new UpdateSecurityException("UPDATE_PACKAGE_INVALID", "Update package metadata is required.");
        if (!Uri.TryCreate(payload.Package.Url, UriKind.Absolute, out var packageUri)
            || !string.Equals(packageUri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || !packageUri.IsDefaultPort
            || !string.IsNullOrEmpty(packageUri.UserInfo)
            || !string.IsNullOrEmpty(packageUri.Fragment))
            throw new UpdateSecurityException("UPDATE_URL_INVALID", "Update package URL must be a canonical HTTPS URL.");
        if (!_allowedPackageHosts.Contains(packageUri.Host))
            throw new UpdateSecurityException("UPDATE_HOST_DENIED", "Update package host is not trusted by Desktop Host policy.");
        var expectedHash = (payload.Package.Sha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (!Sha256Pattern.IsMatch(expectedHash))
            throw new UpdateSecurityException("UPDATE_HASH_INVALID", "Update package SHA-256 is invalid.");
        if (payload.Package.Size is <= 0 or > MaxPackageBytes)
            throw new UpdateSecurityException("UPDATE_PACKAGE_SIZE_INVALID", "Update package size is outside the allowed range.");

        return new VerifiedUpdate(candidateVersion, payload.Channel!, payload.PublishedAt, packageUri, expectedHash, payload.Package.Size, envelope.KeyId!);
    }

    public static PackageVerification VerifyPackage(ReadOnlySpan<byte> packageBytes, VerifiedUpdate update)
    {
        if (update is null) throw new ArgumentNullException(nameof(update));
        if (packageBytes.Length != update.Size)
            throw new UpdateSecurityException("UPDATE_PACKAGE_SIZE_MISMATCH", "Downloaded update size does not match signed metadata.");
        var actualHash = Convert.ToHexString(SHA256.HashData(packageBytes)).ToLowerInvariant();
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(actualHash), Encoding.ASCII.GetBytes(update.Sha256)))
            throw new UpdateSecurityException("UPDATE_PACKAGE_HASH_MISMATCH", "Downloaded update SHA-256 does not match signed metadata.");
        return new PackageVerification(true, actualHash, packageBytes.Length);
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = false };

    private sealed record UpdateEnvelope(string? Schema, string? Algorithm, string? KeyId, string? Payload, string? Signature);
    private sealed record UpdatePayload(string? Schema, string? Version, string? Channel, DateTimeOffset PublishedAt, UpdatePackage? Package);
    private sealed record UpdatePackage(string? Url, string? Sha256, long Size);

    internal sealed record VerifiedUpdate(Version Version, string Channel, DateTimeOffset PublishedAt, Uri PackageUri, string Sha256, long Size, string KeyId);
    internal sealed record PackageVerification(bool Verified, string Sha256, long Size);
}

internal sealed class UpdateSecurityException : Exception
{
    public UpdateSecurityException(string code, string message) : base(message) => Code = code;
    public string Code { get; }
}
