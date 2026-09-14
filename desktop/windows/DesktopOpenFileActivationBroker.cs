using System.Security.Cryptography;

namespace Swir.Desktop.Host;

internal sealed class DesktopOpenFileActivationBroker
{
    private const string Schema = "swir.desktop-open-file-activation/0.1";
    private const int MaxPendingActivations = 32;
    private static readonly TimeSpan ActivationLifetime = TimeSpan.FromMinutes(5);
    private static readonly HashSet<string> SafeExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".txt", ".md", ".log", ".json", ".swirapp"
    };

    private readonly Dictionary<string, PendingActivation> _pending = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    public object Describe()
    {
        lock (_gate)
        {
            PruneExpiredUnsafe();
            return new
            {
                schema = Schema,
                provider = "windows-command-line",
                activationSwitch = "--open-file",
                pendingCount = _pending.Count,
                maxPending = MaxPendingActivations,
                lifetimeSeconds = (int)ActivationLifetime.TotalSeconds,
                nativePathExposure = false,
                oneTimeClaim = true,
                safeExtensions = SafeExtensions.OrderBy(value => value, StringComparer.Ordinal).ToArray()
            };
        }
    }

    public ActivationDescriptor? CaptureCommandLine(IEnumerable<string> arguments)
    {
        ArgumentNullException.ThrowIfNull(arguments);
        var args = arguments.ToArray();
        var switchIndexes = args
            .Select((value, index) => (value, index))
            .Where(item => string.Equals(item.value, "--open-file", StringComparison.Ordinal))
            .Select(item => item.index)
            .ToArray();

        if (switchIndexes.Length == 0) return null;
        if (switchIndexes.Length != 1) throw new InvalidOperationException("Only one --open-file activation is allowed per launch.");

        var switchIndex = switchIndexes[0];
        if (switchIndex + 1 >= args.Length || string.IsNullOrWhiteSpace(args[switchIndex + 1]))
            throw new ArgumentException("--open-file requires a file path.", nameof(arguments));
        if (switchIndex + 2 < args.Length)
            throw new ArgumentException("Unexpected arguments after the --open-file path.", nameof(arguments));

        return CaptureFile(args[switchIndex + 1]);
    }

    public ActivationDescriptor CaptureFile(string filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath)) throw new ArgumentException("Activation file path is required.", nameof(filePath));
        var fullPath = Path.GetFullPath(filePath);
        var info = new FileInfo(fullPath);
        if (!info.Exists) throw new FileNotFoundException("Activation file does not exist.", fullPath);

        var extension = Path.GetExtension(info.Name).ToLowerInvariant();
        if (!SafeExtensions.Contains(extension))
            throw new NotSupportedException($"File extension '{extension}' is outside the SWIR Desktop association allowlist.");

        lock (_gate)
        {
            PruneExpiredUnsafe();
            if (_pending.Count >= MaxPendingActivations)
                throw new InvalidOperationException("Too many pending file activations. Claim or expire an existing activation first.");

            var id = "open_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(18)).ToLowerInvariant();
            var now = DateTimeOffset.UtcNow;
            var pending = new PendingActivation(
                id,
                info.FullName,
                info.Name,
                extension,
                info.Length,
                now,
                now.Add(ActivationLifetime));
            _pending[id] = pending;
            return ToDescriptor(pending);
        }
    }

    public ActivationDescriptor[] Pending()
    {
        lock (_gate)
        {
            PruneExpiredUnsafe();
            return _pending.Values
                .OrderBy(value => value.CreatedAt)
                .Select(ToDescriptor)
                .ToArray();
        }
    }

    internal ClaimedActivation Claim(string activationId)
    {
        if (string.IsNullOrWhiteSpace(activationId)) throw new ArgumentException("Activation id is required.", nameof(activationId));
        lock (_gate)
        {
            PruneExpiredUnsafe();
            if (!_pending.Remove(activationId, out var pending))
                throw new InvalidOperationException("Activation is unknown, expired, or already claimed.");
            if (!File.Exists(pending.NativePath))
                throw new FileNotFoundException("Activation file no longer exists.", pending.NativePath);
            return new ClaimedActivation(
                pending.Id,
                pending.NativePath,
                pending.Name,
                pending.Extension,
                pending.Size,
                pending.CreatedAt);
        }
    }

    public bool Cancel(string activationId)
    {
        if (string.IsNullOrWhiteSpace(activationId)) return false;
        lock (_gate) return _pending.Remove(activationId);
    }

    public int PruneExpired()
    {
        lock (_gate) return PruneExpiredUnsafe();
    }

    private int PruneExpiredUnsafe()
    {
        var now = DateTimeOffset.UtcNow;
        var expired = _pending
            .Where(pair => pair.Value.ExpiresAt <= now)
            .Select(pair => pair.Key)
            .ToArray();
        foreach (var id in expired) _pending.Remove(id);
        return expired.Length;
    }

    private static ActivationDescriptor ToDescriptor(PendingActivation activation)
        => new(
            activation.Id,
            activation.Name,
            activation.Extension,
            activation.Size,
            activation.CreatedAt,
            activation.ExpiresAt,
            "windows-file-association");

    private sealed record PendingActivation(
        string Id,
        string NativePath,
        string Name,
        string Extension,
        long Size,
        DateTimeOffset CreatedAt,
        DateTimeOffset ExpiresAt);

    internal sealed record ActivationDescriptor(
        string Id,
        string Name,
        string Extension,
        long Size,
        DateTimeOffset CreatedAt,
        DateTimeOffset ExpiresAt,
        string Source);

    internal sealed record ClaimedActivation(
        string Id,
        string NativePath,
        string Name,
        string Extension,
        long Size,
        DateTimeOffset CreatedAt);
}
