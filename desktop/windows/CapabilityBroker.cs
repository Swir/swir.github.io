using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Swir.Desktop.Host;

internal sealed class CapabilityBroker
{
    private readonly ConcurrentDictionary<string, CapabilityGrant> _grants = new(StringComparer.Ordinal);
    private readonly TimeSpan _defaultLifetime = TimeSpan.FromMinutes(30);

    public object RegisterFile(string nativePath)
    {
        var info = new FileInfo(nativePath);
        var grant = CreateGrant("file", info.FullName, info.Name);
        return ToPublicDescriptor(grant, new { size = info.Length, modified = info.LastWriteTimeUtc });
    }

    public object RegisterDirectory(string nativePath)
    {
        var info = new DirectoryInfo(nativePath);
        var grant = CreateGrant("directory", info.FullName, info.Name);
        return ToPublicDescriptor(grant);
    }

    public object Describe(string token)
    {
        var grant = Resolve(token);
        return ToPublicDescriptor(grant);
    }

    public string ReadText(string token)
    {
        var grant = Resolve(token, "file");
        return File.ReadAllText(grant.NativePath);
    }

    public bool Revoke(string token)
    {
        return !string.IsNullOrWhiteSpace(token) && _grants.TryRemove(token, out _);
    }

    public int PruneExpired()
    {
        var now = DateTimeOffset.UtcNow;
        var removed = 0;
        foreach (var pair in _grants)
        {
            if (pair.Value.ExpiresAt > now) continue;
            if (_grants.TryRemove(pair.Key, out _)) removed++;
        }
        return removed;
    }

    private CapabilityGrant Resolve(string token, string? requiredKind = null)
    {
        if (string.IsNullOrWhiteSpace(token) || !_grants.TryGetValue(token, out var grant))
            throw new BridgeException("CAPABILITY_INVALID", "Capability token is unknown or has been revoked.");

        if (grant.ExpiresAt <= DateTimeOffset.UtcNow)
        {
            _grants.TryRemove(token, out _);
            throw new BridgeException("CAPABILITY_EXPIRED", "Capability token has expired.");
        }

        if (requiredKind is not null && !string.Equals(grant.Kind, requiredKind, StringComparison.Ordinal))
            throw new BridgeException("CAPABILITY_KIND_MISMATCH", $"Capability token does not grant {requiredKind} access.");

        return grant;
    }

    private CapabilityGrant CreateGrant(string kind, string nativePath, string displayName)
    {
        PruneExpired();
        var token = "cap_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        var grant = new CapabilityGrant(
            token,
            kind,
            nativePath,
            displayName,
            DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow.Add(_defaultLifetime));
        _grants[token] = grant;
        return grant;
    }

    private static object ToPublicDescriptor(CapabilityGrant grant, object? metadata = null)
    {
        return new
        {
            token = grant.Token,
            kind = grant.Kind,
            name = grant.DisplayName,
            issuedAt = grant.IssuedAt,
            expiresAt = grant.ExpiresAt,
            revocable = true,
            metadata
        };
    }

    private sealed record CapabilityGrant(
        string Token,
        string Kind,
        string NativePath,
        string DisplayName,
        DateTimeOffset IssuedAt,
        DateTimeOffset ExpiresAt);
}
