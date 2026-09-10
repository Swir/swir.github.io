using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Swir.Desktop.Host;

internal sealed class PermissionBroker
{
    private readonly string _sessionId;
    private readonly ExecutionPolicyCatalog _policyCatalog;
    private readonly ConcurrentDictionary<string, ExecutionContextGrant> _contexts = new(StringComparer.Ordinal);

    public PermissionBroker(string sessionId, ExecutionPolicyCatalog policyCatalog)
    {
        _sessionId = sessionId;
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
                "runtime.inspect"
            });
    }

    public string ShellExecutionToken { get; }

    public string RegisterApplicationContext(string packageId, IEnumerable<string> grantedPackagePermissions)
    {
        var nativePermissions = _policyCatalog.ResolveNativePermissions(packageId, grantedPackagePermissions);
        return RegisterTrustedContext(packageId, packageId, "package", nativePermissions);
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

    public object Describe(string? token)
    {
        var context = Resolve(token);
        return new
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
    }

    public bool Can(string? token, string permission)
    {
        var context = Resolve(token);
        return context.Permissions.Contains(permission, StringComparer.Ordinal);
    }

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
        ("clipboard", "readText") => "clipboard.read",
        ("clipboard", "writeText" or "clear") => "clipboard.write",
        ("processes", "list" or "open") => "process.inspect",
        ("processes", "spawn") => "process.spawn",
        ("processes", "kill") => "process.kill",
        ("security", "contextInfo" or "can" or "policyCatalog" or "appUrl" or "isolationInfo") => "runtime.inspect",
        _ => null
    };

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
