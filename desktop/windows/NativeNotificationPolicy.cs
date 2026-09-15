namespace Swir.Desktop.Host;

/// <summary>
/// Host-owned validation and abuse-control policy for native notifications.
/// This layer is deliberately UI-independent so the same contract can be reused
/// by future Linux/Desktop adapters without trusting browser supplied metadata.
/// </summary>
internal sealed class NativeNotificationPolicy
{
    private readonly Dictionary<string, Queue<DateTimeOffset>> _deliveries = new(StringComparer.Ordinal);
    private readonly Dictionary<string, RecentNotification> _recent = new(StringComparer.Ordinal);
    private readonly Func<DateTimeOffset> _clock;
    private readonly int _maxPerWindow;
    private readonly TimeSpan _window;
    private readonly TimeSpan _duplicateWindow;

    internal NativeNotificationPolicy(
        Func<DateTimeOffset>? clock = null,
        int maxPerWindow = 8,
        TimeSpan? window = null,
        TimeSpan? duplicateWindow = null)
    {
        if (maxPerWindow < 1) throw new ArgumentOutOfRangeException(nameof(maxPerWindow));
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
        _maxPerWindow = maxPerWindow;
        _window = window ?? TimeSpan.FromMinutes(1);
        _duplicateWindow = duplicateWindow ?? TimeSpan.FromSeconds(2);
    }

    internal NativeNotificationRequest Prepare(string? title, string? message, string? appId, bool silent)
    {
        var normalizedAppId = NormalizeAppId(appId);
        var normalizedTitle = NormalizeText(title, "SWIR OS", 63);
        var normalizedMessage = NormalizeText(message, "Application event", 255);
        var now = _clock();

        if (!_deliveries.TryGetValue(normalizedAppId, out var deliveries))
        {
            deliveries = new Queue<DateTimeOffset>();
            _deliveries[normalizedAppId] = deliveries;
        }
        while (deliveries.Count > 0 && now - deliveries.Peek() >= _window) deliveries.Dequeue();
        if (deliveries.Count >= _maxPerWindow)
            throw new NativeNotificationException("NOTIFICATION_RATE_LIMITED", "The application exceeded the native notification delivery limit.");

        var fingerprint = string.Concat(normalizedTitle, "\n", normalizedMessage, "\n", silent ? "1" : "0");
        if (_recent.TryGetValue(normalizedAppId, out var recent)
            && string.Equals(recent.Fingerprint, fingerprint, StringComparison.Ordinal)
            && now - recent.Timestamp < _duplicateWindow)
            throw new NativeNotificationException("NOTIFICATION_DUPLICATE", "A duplicate native notification was suppressed.");

        deliveries.Enqueue(now);
        _recent[normalizedAppId] = new RecentNotification(fingerprint, now);
        return new NativeNotificationRequest(normalizedTitle, normalizedMessage, normalizedAppId, silent);
    }

    private static string NormalizeAppId(string? value)
    {
        var appId = string.IsNullOrWhiteSpace(value) ? "swir.system" : value.Trim();
        if (appId.Length > 128 || appId.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '.' or '-' or '_')))
            throw new NativeNotificationException("INVALID_APP_ID", "Native notification application identity contains unsupported characters.");
        return appId;
    }

    private static string NormalizeText(string? value, string fallback, int maxLength)
    {
        var normalized = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
        normalized = new string(normalized.Where(ch => !char.IsControl(ch) || ch is '\t').ToArray());
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private sealed record RecentNotification(string Fingerprint, DateTimeOffset Timestamp);
}

internal sealed record NativeNotificationRequest(string Title, string Message, string AppId, bool Silent);

internal sealed class NativeNotificationException(string code, string message) : Exception(message)
{
    internal string Code { get; } = code;
}
