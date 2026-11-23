"""Shared test setup: never let a test reach a real AI provider."""
import pytest

import ai_suggest


@pytest.fixture(autouse=True)
def no_ai_keys(monkeypatch):
    """Tests that use the default AiSuggester read os.environ. Drop the provider
    keys so a key set in the developer's shell can't trigger real API calls
    (for example the background GPU estimate after creating a task)."""
    for provider in ai_suggest.PROVIDERS.values():
        monkeypatch.delenv(provider.key_env, raising=False)
    monkeypatch.delenv(ai_suggest.PROVIDER_ENV, raising=False)
