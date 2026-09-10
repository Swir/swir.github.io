using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Swir.Desktop.Host;

internal sealed class PermissionBroker
{
    private readonly string _sessionId;
    private readonly CapabilityBroker _capabilities;
    private readonly ExecutionPolicyCatalog _policyCatalog;
    private readonly ConcurrentDictionary<string, ExecutionContextGrant> _contexts = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> _packageTokens = new(StringComparer.Ordinal);
    private readonly object _syncGate = new();

    public PermissionBroker(CapabilityBroker capabilities, ExecutionPolicyCatalog policyCatalog)
    {
        _capabilities = capabilities;
        _sessionId = capabilities.SessionId;
        _policyCatalog = policyCatalog;
        ShellExecutionToken = RegisterTrustedContext(
            "swir.system.shell",
            null,
            "shell",
            new[]
            {
                "filesystem.sandbox.read",
                "filesystem.sandbox.write",
                "filesystem.picker",
                "filesystem.capability.read",
                "filesystem.capability.manage",
                "clipboard.read",
                "clipboard.write",
                "process.inspect",
                "runtime.inspect",
                "runtime.context.manage"
            });
    }

    public string ShellExecutionToken { get; }

    public object SynchronizeApplicationContexts(IEnumerable<PackageContextRequest> requestedContexts)
    {
        var requested = requestedContexts?.ToArray() ?? Array.Empty<PackageContextRequest>();
        var duplicates = requested.GroupBy(x => x.PackageId, StringComparer.Ordinal).Where(g => g.Count() > 1).Select(g => g.Key).ToArray();
        if (duplicates.Length > 0)
            throw new BridgeException("PACKAGE_CONTEXT_DUPLICATE", $"Duplicate package context requests: {string.Join(", ", duplicates)}");

        var planned = requested.Select(request => new PlannedPackageContext(
            request.PackageId,
            _policyCatalog.ResolveNativePermissions(request.PackageId, request.Permissions ?? Array.Empty<string>()),
            (request.Permissions ?? Array.Empty<string>()).Distinct(StringComparer.Ordinal).OrderBy(x => x, StringComparer.Ordinal).ToArray()))
            .OrderBy(x => x.PackageId, StringComparer.Ordinal)
            .ToArray();

        lock (_syncGate)
        {
            var wanted = planned.Select(x => x.PackageId).ToHashSet(StringComparer.Ordinal);
            foreach (var packageId in _packageTokens.Keys.Where(x => !wanted.Contains(x)).ToArray())
                RemovePackageContext(packageId, revokeCapabilities: true);

            foreach (var item in planned)
            {
                if (_packageTokens.TryGetValue(item.PackageId, out var existingToken)
                    && _contexts.TryGetValue(existingToken, out var existing)
                    && existing.Permissions.SequenceEqual(item.NativePermissions, StringComparer.Ordinal))
                    continue;

                RemovePackageContext(item.PackageId, revokeCapabilities: true);
                var token = RegisterTrustedContext(item.PackageId, item.PackageId, "package", item.NativePermissions);
                _packageTokens[item.PackageId] = token;
            }
        }

        return DescribePackageContexts();
    }

    public string RequirePackageExecutionToken(string packageId)
    {
        if (string.IsNullOrWhiteSpace(packageId) || !_packageTokens.TryGetValue(packageId, out var token) || !_contexts.ContainsKey(token))
            throw new BridgeException("PACKAGE_CONTEXT_NOT_READY", $"No active Desktop execution context exists for {packageId}.");
        return token;
    }

    public ExecutionContextGrant Authorize(string? token, string surface, string method, string? requestedOwnerAppId = null)
    {
        var context = Resolve(token);
        if (requestedOwnerAppId is not null && !string.Equals(context.AppId, requestedOwnerAppId, StringComparison.Ordinal))
            throw new BridgeException("EXECUTION_IDENTITY_MISMATCH", "Native request owner does not match the authenticated execution context.");

        var required = RequiredPermission(surface, method);
        if (required is null)
            throw new BridgeException("RUNTIME_UNSUPPORTED", $"No permission policy exists for {surface}.{method}.");
        if (!context.Permissions.Contains(required, StringComparer.Ordinal))
            throw new BridgeException("PERMISSION_DENIED", $"Execution context {context.AppId} is not granted {required}.");
        return context;
    }

    public ExecutionContextGrant AuthorizePackageTarget(string? callerToken, string packageId, string surface, string method)
    {
        var caller = Resolve(callerToken);
        if (!string.Equals(caller.Kind, "shell", StringComparison.Ordinal)
            && !string.Equals(caller.PackageId, packageId, StringComparison.Ordinal))
            throw new BridgeException("EXECUTION_IDENTITY_MISMATCH", "Application may only access its own native App Data.");
        if (string.Equals(caller.Kind, "shell", StringComparison.Ordinal)
            && !caller.Permissions.Contains("runtime.context.manage", StringComparer.Ordinal))
            throw new BridgeException("PERMISSION_DENIED", "Shell context is not allowed to broker package App Data.");

        var packageToken = RequirePackageExecutionToken(packageId);
        return Authorize(packageToken, surface, method, packageId);
    }

    public object Describe(string? token)
    {
        var context = Resolve(token);
        return DescribeContext(context);
    }

    public object DescribePackageContexts()
    {
        var contexts = _packageTokens.OrderBy(x => x.Key, StringComparer.Ordinal)
            .Select(pair => _contexts.TryGetValue(pair.Value, out var context) ? context : null)
            .Where(context => context is not null)
            .Select(context => new
            {
                packageId = context!.PackageId,
                appId = context.AppId,
                kind = context.Kind,
                sessionId = context.SessionId,
                trusted = context.Trusted,
                issuedAt = context.IssuedAt,
                permissions = context.Permissions,
                tokenExposed = false
            })
            .ToArray();
        return new { schema = "swir.desktop-execution-contexts/0.1", sessionId = _sessionId, count = contexts.Length, contexts };
    }

    public bool Can(string? token, string permission)
    {
        var context = Resolve(token);
        return context.Permissions.Contains(permission, StringComparer.Ordinal);
    }

    private object DescribeContext(ExecutionContextGrant context) => new
    {
        appId = context.AppId,
        packageId = context.PackageId,
        kind = context.Kind,
        sessionId = context.SessionId,
        trusted = context.Trusted,
        issuedAt = context.IssuedAt,
        permissions = context.Permissions.OrderBy(x => x, StringComparer.Ordinal).ToArray(),
        tokenExposed = false
    };

    private string RegisterTrustedContext(string appId, string? packageId, string kind, IEnumerable<string> permissions)
    {
        var token = "exec_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var grant = new ExecutionContextGrant(
            token,
            appId,
            packageId,
            kind,
            _sessionId,
            true,
            DateTimeOffset.UtcNow,
            permissions.Distinct(StringComparer.Ordinal).OrderBy(x => x, StringComparer.Ordinal).ToArray());
        _contexts[token] = grant;
        return token;
    }

    private void RemovePackageContext(string packageId, bool revokeCapabilities)
    {
        if (_packageTokens.TryRemove(packageId, out var token)) _contexts.TryRemove(token, out _);
        if (revokeCapabilities) _capabilities.RevokeOwner(packageId);
    }

    private ExecutionContextGrant Resolve(string? token)
    {
        if (string.IsNullOrWhiteSpace(token) || !_contexts.TryGetValue(token, out var context))
            throw new BridgeException("EXECUTION_CONTEXT_INVALID", "Native call is missing a valid execution context.");
        if (!string.Equals(context.SessionId, _sessionId, StringComparison.Ordinal))
            throw new BridgeException("EXECUTION_SESSION_MISMATCH", "Execution context belongs to another host session.");
        return context;
    }

    private static string? RequiredPermission(string surface, string method) => (surface, method) switch
    {
        ("filesystem", "list" or "get") => "filesystem.sandbox.read",
        ("filesystem", "save" or "remove") => "filesystem.sandbox.write",
        ("filesystem", "pickFile" or "pickDirectory") => "filesystem.picker",
        ("filesystem", "capabilityInfo" or "readCapabilityText") => "filesystem.capability.read",
        ("filesystem", "revokeCapability" or "revokeOwnerCapabilities" or "pruneCapabilities" or "capabilityStatus") => "filesystem.capability.manage",
        ("appdata", "get" or "list" or "info") => "filesystem.sandbox.read",
        ("appdata", "set" or "remove") => "filesystem.sandbox.write",
        ("clipboard", "readText") => "clipboard.read",
        ("clipboard", "writeText" or "clear") => "clipboard.write",
        ("processes", "list" or "open") => "process.inspect",
        ("processes", "spawn") => "process.spawn",
        ("processes", "kill") => "process.kill",
        ("security", "syncPackageContexts") => "runtime.context.manage",
        ("security", "contextInfo" or "can" or "policyCatalog" or "appUrl" or "isolationInfo" or "packageContexts") => "runtime.inspect",
        _ => null
    };

    internal sealed record PackageContextRequest(string PackageId, string[]? Permissions);
    private sealed record PlannedPackageContext(string PackageId, string[] NativePermissions, string[] PackagePermissions);
    internal sealed record ExecutionContextGrant(
        string Token,
        string AppId,
        string? PackageId,
        string Kind,
        string SessionId,
        bool Trusted,
        DateTimeOffset IssuedAt,
        string[] Permissions);
}
