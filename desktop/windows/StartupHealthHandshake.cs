namespace Swir.Desktop.Host;

/// <summary>
/// Candidate-side one-shot health proof. The launcher injects the secret only into
/// the candidate process environment; this class captures and immediately removes
/// those values, then commits the transaction only after the shell reports ready.
/// </summary>
internal sealed class StartupHealthHandshake
{
    private readonly UpdateTransactionJournal _journal;
    private readonly UpdateHealthBroker _health;
    private readonly string _journalPath;
    private readonly string _transactionId;
    private readonly Version _targetVersion;
    private readonly string _token;
    private int _completed;

    private StartupHealthHandshake(
        UpdateTransactionJournal journal,
        UpdateHealthBroker health,
        string journalPath,
        string transactionId,
        Version targetVersion,
        string token)
    {
        _journal = journal;
        _health = health;
        _journalPath = journalPath;
        _transactionId = transactionId;
        _targetVersion = targetVersion;
        _token = token;
    }

    public static StartupHealthHandshake? CaptureFromEnvironment()
    {
        var transactionId = Environment.GetEnvironmentVariable(ControlledCandidateLauncher.TransactionEnvironment);
        var targetVersionText = Environment.GetEnvironmentVariable(ControlledCandidateLauncher.TargetVersionEnvironment);
        var token = Environment.GetEnvironmentVariable(ControlledCandidateLauncher.HealthTokenEnvironment);
        var journalPath = Environment.GetEnvironmentVariable(ControlledCandidateLauncher.JournalEnvironment);

        // Secrets must not remain inherited by child processes created after startup.
        Environment.SetEnvironmentVariable(ControlledCandidateLauncher.TransactionEnvironment, null);
        Environment.SetEnvironmentVariable(ControlledCandidateLauncher.TargetVersionEnvironment, null);
        Environment.SetEnvironmentVariable(ControlledCandidateLauncher.HealthTokenEnvironment, null);
        Environment.SetEnvironmentVariable(ControlledCandidateLauncher.JournalEnvironment, null);

        var present = new[] { transactionId, targetVersionText, token, journalPath }.Count(value => !string.IsNullOrWhiteSpace(value));
        if (present == 0) return null;
        if (present != 4)
            throw new UpdateSecurityException("UPDATE_STARTUP_HEALTH_ENV_INCOMPLETE", "Candidate health environment is incomplete.");

        if (!Version.TryParse(targetVersionText, out var targetVersion))
            throw new UpdateSecurityException("UPDATE_STARTUP_HEALTH_VERSION_INVALID", "Candidate target version is invalid.");
        if (string.IsNullOrWhiteSpace(transactionId)
            || transactionId.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '.' or '-')))
            throw new UpdateSecurityException("UPDATE_STARTUP_HEALTH_TRANSACTION_INVALID", "Candidate transaction id is invalid.");
        if (string.IsNullOrWhiteSpace(token) || token.Length != 64 || token.Any(ch => !Uri.IsHexDigit(ch)))
            throw new UpdateSecurityException("UPDATE_STARTUP_HEALTH_TOKEN_INVALID", "Candidate health token is malformed.");

        var canonicalJournal = Path.GetFullPath(journalPath!);
        if (!string.Equals(Path.GetFileName(canonicalJournal), "transaction.json", StringComparison.OrdinalIgnoreCase))
            throw new UpdateSecurityException("UPDATE_STARTUP_HEALTH_JOURNAL_INVALID", "Candidate journal path is not canonical.");
        var transactionDirectory = Path.GetDirectoryName(canonicalJournal)
            ?? throw new UpdateSecurityException("UPDATE_STARTUP_HEALTH_JOURNAL_INVALID", "Candidate transaction directory is invalid.");
        if (!string.Equals(Path.GetFileName(transactionDirectory), transactionId, StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_STARTUP_HEALTH_JOURNAL_INVALID", "Candidate journal directory does not match transaction id.");
        var transactionsRoot = Path.GetDirectoryName(transactionDirectory)
            ?? throw new UpdateSecurityException("UPDATE_STARTUP_HEALTH_JOURNAL_INVALID", "Candidate transactions root is invalid.");

        var journal = new UpdateTransactionJournal(transactionsRoot);
        var state = journal.Read(canonicalJournal);
        if (!string.Equals(state.TransactionId, transactionId, StringComparison.Ordinal)
            || state.TargetVersion != targetVersion
            || !string.Equals(state.State, "awaiting-health-check", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_STARTUP_HEALTH_STATE_INVALID", "Candidate health environment does not match the active transaction.");

        return new StartupHealthHandshake(
            journal,
            new UpdateHealthBroker(journal),
            canonicalJournal,
            transactionId,
            targetVersion,
            token!);
    }

    public UpdateTransactionJournal.TransactionState ConfirmShellReady()
    {
        if (Interlocked.Exchange(ref _completed, 1) != 0)
            throw new UpdateSecurityException("UPDATE_STARTUP_HEALTH_ALREADY_USED", "Candidate startup health proof is one-shot.");

        var state = _journal.Read(_journalPath);
        if (!string.Equals(state.TransactionId, _transactionId, StringComparison.Ordinal)
            || state.TargetVersion != _targetVersion
            || !string.Equals(state.State, "awaiting-health-check", StringComparison.Ordinal))
            throw new UpdateSecurityException("UPDATE_STARTUP_HEALTH_STATE_INVALID", "Candidate transaction changed before shell readiness.");

        return _health.Confirm(state, _token, _targetVersion);
    }
}
