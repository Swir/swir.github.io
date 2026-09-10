using Microsoft.Web.WebView2.Core;

namespace Swir.Desktop.Host;

internal sealed class AppIsolationRegistry
{
    private readonly Dictionary<string, IsolationEntry> _byPackage = new(StringComparer.Ordinal);
    private readonly Dictionary<string, IsolationEntry> _byHost = new(StringComparer.OrdinalIgnoreCase);

    public AppIsolationRegistry(ExecutionPolicyCatalog catalog)
    {
        foreach (var policy in catalog.All())
        {
            var host = BuildHost(policy.PackageId);
            var entry = new IsolationEntry(policy.PackageId, NormalizeEntry(policy.Entry), host);
            _byPackage.Add(policy.PackageId, entry);
            _byHost.Add(host, entry);
        }
    }

    public void Configure(CoreWebView2 core, string repoRoot)
    {
        foreach (var item in _byPackage.Values)
            core.SetVirtualHostNameToFolderMapping(item.Host, repoRoot, CoreWebView2HostResourceAccessKind.DenyCors);
    }

    public string AppUrl(string packageId, string requestedEntry)
    {
        if (!_byPackage.TryGetValue(packageId, out var item))
            throw new BridgeException("PACKAGE_POLICY_MISSING", $"No isolated Desktop origin exists for {packageId}.");

        var normalized = NormalizeEntry(requestedEntry);
        if (!string.Equals(normalized, item.Entry, StringComparison.Ordinal))
            throw new BridgeException("PACKAGE_ENTRY_MISMATCH", $"Requested entry does not match trusted policy for {packageId}.");

        return $"https://{item.Host}/{normalized}";
    }

    public object Describe() => new
    {
        schema = "swir.app-isolation/0.2",
        routingEnabled = false,
        routingState = "APP_API_BRIDGE_PENDING",
        packageCount = _byPackage.Count,
        packages = _byPackage.Values.OrderBy(x => x.PackageId, StringComparer.Ordinal)
            .Select(x => new { packageId = x.PackageId, entry = x.Entry, origin = $"https://{x.Host}" }).ToArray()
    };

    public bool TryResolveEntrySource(string? source, out string? packageId)
    {
        packageId = null;
        if (!Uri.TryCreate(source, UriKind.Absolute, out var uri)
            || !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || !string.IsNullOrEmpty(uri.UserInfo))
            return false;
        if (!_byHost.TryGetValue(uri.Host, out var entry)) return false;

        var path = Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');
        if (!string.Equals(path, entry.Entry, StringComparison.Ordinal)) return false;
        packageId = entry.PackageId;
        return true;
    }

    private static string BuildHost(string packageId)
    {
        var slug = packageId.ToLowerInvariant().Select(ch => char.IsLetterOrDigit(ch) ? ch : '-').ToArray();
        return $"app-{new string(slug)}.swir.local";
    }

    private static string NormalizeEntry(string entry)
    {
        var value = (entry ?? string.Empty).Trim();
        while (value.StartsWith("./", StringComparison.Ordinal)) value = value[2..];
        if (string.IsNullOrWhiteSpace(value)
            || value.Contains("..", StringComparison.Ordinal)
            || value.Contains('\\')
            || value.StartsWith("/", StringComparison.Ordinal)
            || value.Contains('?', StringComparison.Ordinal)
            || value.Contains('#', StringComparison.Ordinal)
            || Uri.TryCreate(value, UriKind.Absolute, out _))
            throw new BridgeException("INVALID_PACKAGE_ENTRY", "Package entry must be a safe repository-relative path.");
        return value;
    }

    private sealed record IsolationEntry(string PackageId, string Entry, string Host);
}
