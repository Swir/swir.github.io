using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Swir.Desktop.Host;

internal sealed class CapabilityBroker
{
    private const long MaxTextReadBytes = 2 * 1024 * 1024;
    private readonly ConcurrentDictionary<string, CapabilityGrant> _grants = new(StringComparer.Ordinal);
    private readonly TimeSpan _defaultLifetime = TimeSpan.FromMinutes(30);
    private readonly string _sessionId = "session_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();

    public string SessionId => _sessionId;

    public object RegisterFile(string nativePath, string ownerAppId)
    {
        var info = new FileInfo(nativePath);
        if (!info.Exists) throw new BridgeException("RESOURCE_NOT_FOUND", "Selected file no longer exists.");
        var grant = CreateGrant("file", info.FullName, info.Name, ownerAppId);
        return ToPublicDescriptor(grant, new { size = info.Length, modified = info.LastWriteTimeUtc });
    }

    public object RegisterDirectory(string nativePath, string ownerAppId)
    {
        var info = new DirectoryInfo(nativePath);
        if (!info.Exists) throw new BridgeException("RESOURCE_NOT_FOUND", "Selected directory no longer exists.");
        var grant = CreateGrant("directory", info.FullName, info.Name, ownerAppId);
        return ToPublicDescriptor(grant);
    }

    public object Describe(string token, string ownerAppId)
    {
        var grant = Resolve(token, ownerAppId);
        return ToPublicDescriptor(grant);
    }

    public string ReadText(string token, string ownerAppId)
    {
        var grant = Resolve(token, ownerAppId, "file");
        var info = new FileInfo(grant.NativePath);
        if (!info.Exists) throw new BridgeException("RESOURCE_NOT_FOUND", "Capability resource no longer exists.");
        if (info.Length > MaxTextReadBytes)
            throw new BridgeException("RESOURCE_TOO_LARGE", $"Text reads are limited to {MaxTextReadBytes} bytes in this preview.");
        return File.ReadAllText(grant.NativePath);
    }

    public bool Revoke(string token, string ownerAppId)
    {
        var grant = Resolve(token, ownerAppId);
        return _grants.TryRemove(grant.Token, out _);
    }

    public int RevokeOwner(string ownerAppId)
    {
        var removed = 0;
        foreach (var pair in _grants)
        {
            if (!string.Equals(pair.Value.OwnerAppId, ownerAppId, StringComparison.Ordinal)) continue;
            if (_grants.TryRemove(pair.Key, out _)) removed++;
        }
        return removed;
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

    public object Status()
    {
        PruneExpired();
        return new
        {
            sessionId = _sessionId,
            activeGrants = _grants.Count,
            lifetimeMinutes = (int)_defaultLifetime.TotalMinutes,
            maxTextReadBytes = MaxTextReadBytes,
            ownerBound = true,
            persistent = false
        };
    }

    private CapabilityGrant Resolve(string token, string ownerAppId, string? requiredKind = null)
    {
        if (string.IsNullOrWhiteSpace(token) || !_grants.TryGetValue(token, out var grant))
            throw new BridgeException("CAPABILITY_INVALID", "Capability token is unknown or has been revoked.");

        if (!string.Equals(grant.SessionId, _sessionId, StringComparison.Ordinal))
        {
            _grants.TryRemove(token, out _);
            throw new BridgeException("CAPABILITY_SESSION_MISMATCH", "Capability belongs to another host session.");
        }

        if (!string.Equals(grant.OwnerAppId, ownerAppId, StringComparison.Ordinal))
            throw new BridgeException("CAPABILITY_OWNER_MISMATCH", "Capability belongs to another application identity.");

        if (grant.ExpiresAt <= DateTimeOffset.UtcNow)
        {
            _grants.TryRemove(token, out _);
            throw new BridgeException("CAPABILITY_EXPIRED", "Capability token has expired.");
        }

        if (requiredKind is not null && !string.Equals(grant.Kind, requiredKind, StringComparison.Ordinal))
            throw new BridgeException("CAPABILITY_KIND_MISMATCH", $"Capability token does not grant {requiredKind} access.");

        return grant;
    }

    private CapabilityGrant CreateGrant(string kind, string nativePath, string displayName, string ownerAppId)
    {
        PruneExpired();
        var token = "cap_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        var grant = new CapabilityGrant(
            token,
            kind,
            nativePath,
            displayName,
            ownerAppId,
            _sessionId,
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
            ownerAppId = grant.OwnerAppId,
            sessionId = grant.SessionId,
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
        string OwnerAppId,
        string SessionId,
        DateTimeOffset IssuedAt,
        DateTimeOffset ExpiresAt);
}
