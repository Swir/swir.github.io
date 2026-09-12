using System.Security.Cryptography;
using System.Text.Json;

namespace Swir.Desktop.Host;

internal sealed class DesktopUpdateReleasePolicy
{
    public const string PolicySchema = "swir.desktop-update-policy/0.1";

    private DesktopUpdateReleasePolicy(
        bool enabled,
        string channel,
        Uri? manifestUri,
        string[] manifestHosts,
        string[] packageHosts,
        string? publicKeyPem)
    {
        Enabled = enabled;
        Channel = channel;
        ManifestUri = manifestUri;
        ManifestHosts = manifestHosts;
        PackageHosts = packageHosts;
        PublicKeyPem = publicKeyPem;
    }

    public bool Enabled { get; }
    public string Channel { get; }
    public Uri? ManifestUri { get; }
    public string[] ManifestHosts { get; }
    public string[] PackageHosts { get; }
    public string? PublicKeyPem { get; }

    public static DesktopUpdateReleasePolicy Load(string policyPath)
    {
        if (string.IsNullOrWhiteSpace(policyPath))
            throw new UpdateSecurityException("UPDATE_POLICY_PATH_INVALID", "Desktop update policy path is required.");

        var fullPath = Path.GetFullPath(policyPath);
        if (!File.Exists(fullPath))
            return Disabled();

        PolicyDocument? document;
        try
        {
            var json = File.ReadAllText(fullPath);
            document = JsonSerializer.Deserialize<PolicyDocument>(json, JsonOptions);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            throw new UpdateSecurityException("UPDATE_POLICY_INVALID", "Desktop update policy could not be read or decoded.");
        }

        if (document is null || !string.Equals(document.Schema, PolicySchema, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_POLICY_SCHEMA_UNSUPPORTED", "Desktop update policy schema is not supported.");
        if (!document.Enabled)
            return Disabled(NormalizeChannel(document.Channel));

        var channel = NormalizeChannel(document.Channel);
        var manifestHosts = NormalizeHosts(document.ManifestHosts, "UPDATE_MANIFEST_HOST_POLICY_EMPTY");
        var packageHosts = NormalizeHosts(document.PackageHosts, "UPDATE_HOST_POLICY_EMPTY");
        if (!Uri.TryCreate(document.ManifestUrl, UriKind.Absolute, out var manifestUri)
            || !string.Equals(manifestUri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || !manifestUri.IsDefaultPort
            || !string.IsNullOrEmpty(manifestUri.UserInfo)
            || !string.IsNullOrEmpty(manifestUri.Fragment)
            || !manifestHosts.Contains(manifestUri.Host, StringComparer.OrdinalIgnoreCase))
            throw new UpdateSecurityException("UPDATE_MANIFEST_URL_INVALID", "Enabled Desktop update policy requires a canonical HTTPS manifest URL on an explicitly trusted host.");

        var publicKeyPem = document.PublicKeyPem?.Trim();
        if (string.IsNullOrWhiteSpace(publicKeyPem))
            throw new UpdateSecurityException("UPDATE_KEY_MISSING", "Enabled Desktop update policy requires a release verification public key.");
        try
        {
            using var rsa = RSA.Create();
            rsa.ImportFromPem(publicKeyPem);
            if (rsa.KeySize < 2048)
                throw new UpdateSecurityException("UPDATE_KEY_INVALID", "Release verification RSA key must be at least 2048 bits.");
        }
        catch (UpdateSecurityException) { throw; }
        catch (Exception ex) when (ex is ArgumentException or CryptographicException)
        {
            throw new UpdateSecurityException("UPDATE_KEY_INVALID", "Release verification public key is invalid.");
        }

        return new DesktopUpdateReleasePolicy(true, channel, manifestUri, manifestHosts, packageHosts, publicKeyPem);
    }

    public object Describe() => new
    {
        schema = PolicySchema,
        enabled = Enabled,
        channel = Channel,
        manifestConfigured = ManifestUri is not null,
        manifestHost = ManifestUri?.Host,
        packageHosts = PackageHosts,
        verificationKeyConfigured = !string.IsNullOrWhiteSpace(PublicKeyPem),
        failClosed = true
    };

    private static DesktopUpdateReleasePolicy Disabled(string channel = "stable")
        => new(false, channel, null, Array.Empty<string>(), Array.Empty<string>(), null);

    private static string NormalizeChannel(string? channel)
    {
        var value = string.IsNullOrWhiteSpace(channel) ? "stable" : channel.Trim().ToLowerInvariant();
        if (value.Length > 32 || value.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '-' or '_')))
            throw new UpdateSecurityException("UPDATE_CHANNEL_INVALID", "Desktop update policy channel is invalid.");
        return value;
    }

    private static string[] NormalizeHosts(string[]? hosts, string emptyCode)
    {
        var normalized = (hosts ?? Array.Empty<string>())
            .Select(host => (host ?? string.Empty).Trim().TrimEnd('.').ToLowerInvariant())
            .Where(host => host.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(host => host, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (normalized.Length == 0)
            throw new UpdateSecurityException(emptyCode, "Enabled Desktop update policy requires an explicit trusted host allowlist.");
        foreach (var host in normalized)
        {
            if (host.Length > 253 || host.Contains('/') || host.Contains(':') || host.Contains('*') || host.Any(char.IsWhiteSpace))
                throw new UpdateSecurityException("UPDATE_HOST_POLICY_INVALID", "Desktop update host allowlist contains an invalid host.");
        }
        return normalized;
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false,
        AllowTrailingCommas = false,
        ReadCommentHandling = JsonCommentHandling.Disallow
    };

    private sealed record PolicyDocument(
        string? Schema,
        bool Enabled,
        string? Channel,
        string? ManifestUrl,
        string[]? ManifestHosts,
        string[]? PackageHosts,
        string? PublicKeyPem);
}
