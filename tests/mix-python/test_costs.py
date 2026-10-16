import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services/mix/python'))

from costs import billing_scope, paid_post
from credits import CreditError
from api import Models
from app import Jobs
from test_credits import Wallet, checked_runner


class CostWallet(Wallet):
    def snapshot(self, owner):
        return {**super().snapshot(owner), 'pricing': {'mode': 'api_cost'}}

    def close_scope(self, owner, scope):
        return {'costMicros': 12000, 'chargedPoints': 2}

    def settle(self, owner, task, units):
        record = self.records[task]
        record.update(status='settled', chargedPoints=0)
        return record


class CostTests(unittest.TestCase):
    def test_missing_owner_context_cannot_dispatch_paid_calls(self):
        with patch.dict(os.environ, {'MIX_API_COST_ENABLED': '1'}):
            with self.assertRaises(CreditError):
                paid_post('https://api.openlux.ai/v1/rerank', {})

    def test_models_use_private_provider_bridge_and_close_the_same_owned_scope(self):
        client = Mock()
        client.provider.return_value = {'embedding': {'values': [1, 0]}}
        with patch.dict(os.environ, {'MIX_API_COST_ENABLED': '1'}), patch('costs.configured_credits', return_value=client):
            with billing_scope('a' * 64, 'job:' + 'b' * 32):
                self.assertEqual(Models().embed(text='天空').tolist(), [1, 0])
        self.assertEqual(client.provider.call_args.args[:2], ('a' * 64, 'job:' + 'b' * 32))
        client.close_scope.assert_called_once_with('a' * 64, 'job:' + 'b' * 32)

    def test_legacy_scope_keeps_existing_duration_billing_and_cleans_context_on_errors(self):
        with patch.dict(os.environ, {'MIX_API_COST_ENABLED': '1'}):
            with self.assertRaisesRegex(ValueError, 'invalid output'):
                with billing_scope('owner', 'job', legacy=True):
                    self.assertIsNone(paid_post('legacy-url', {}))
                    raise ValueError('invalid output')
            with self.assertRaises(CreditError):
                paid_post('legacy-url', {})

    def test_api_cost_job_does_not_require_duration_prices_or_reject_unlimited_accounts(self):
        with tempfile.TemporaryDirectory() as root:
            wallet = CostWallet(unlimited=True)
            jobs = Jobs(root, credits=wallet)
            spec = {'owner': 'a' * 64, 'text': '按实际调用费用制作', 'source': 'cloud'}
            ident = jobs.submit('actual-cost', spec)
            self.assertEqual(jobs.get(ident)['state'], 'queued')
            self.assertEqual(jobs.get(ident)['billing']['billingMode'], 'api_cost')
            self.assertEqual(jobs.get(ident)['billing']['initialUnits'], 0)
            jobs._extend(ident, spec, 30)

    def test_real_duration_does_not_replace_actual_api_cost_summary(self):
        with tempfile.TemporaryDirectory() as root:
            jobs = Jobs(root, credits=CostWallet())
            spec = {'owner': 'a' * 64, 'text': '真实调用费用', 'source': 'cloud'}
            ident = jobs.submit('actual-cost', spec)
            with patch('app.media_duration', return_value=60):
                jobs.run_one(checked_runner)
            result = jobs.get(ident)
            self.assertEqual(result['state'], 'done')
            self.assertEqual(result['billing']['chargedPoints'], 2)
            self.assertEqual(result['billing']['costMicros'], 12000)
            self.assertEqual(result['billing']['actualSeconds'], 60)

    def test_missing_bill_blocks_delivery_and_resume_keeps_the_saved_checked_video(self):
        with tempfile.TemporaryDirectory() as root:
            wallet = CostWallet()
            wallet.close_scope = Mock(side_effect=CreditError('费用待确认', uncertain=True))
            jobs = Jobs(root, credits=wallet)
            ident = jobs.submit('actual-cost', {'owner': 'a' * 64, 'text': '费用核对', 'source': 'cloud'})
            runner = Mock(side_effect=checked_runner)
            with patch('app.media_duration', return_value=30):
                jobs.run_one(runner)
                self.assertEqual(jobs.get(ident)['state'], 'interrupted')
                wallet.close_scope.side_effect = None
                wallet.close_scope.return_value = {'costMicros': 12000, 'chargedPoints': 2}
                jobs.resume(ident, 'a' * 64)
                jobs.run_one(runner)
            self.assertEqual(jobs.get(ident)['state'], 'done')
            self.assertEqual(runner.call_count, 1)

    def test_embedding_retries_only_a_confirmed_rejected_envelope(self):
        client = Mock()
        client.provider.side_effect = [CreditError('HTTP 400', 400, 'MIX_PROVIDER_REJECTED'), {'embedding': {'values': [1, 0]}}]
        with patch.dict(os.environ, {'MIX_API_COST_ENABLED': '1'}), patch('costs.configured_credits', return_value=client):
            with billing_scope('a' * 64, 'job:' + 'b' * 32):
                self.assertEqual(Models().embed(text='天空').tolist(), [1, 0])
        first, second = client.provider.call_args_list
        self.assertIn('content', first.args[3])
        self.assertEqual(first.args[3], second.args[3])

    def test_paid_invalid_json_is_marked_for_a_fresh_explicit_retry(self):
        client = Mock()
        client.provider.return_value = {'candidates': [{'content': {'parts': [{'text': 'not JSON'}]}, 'finishReason': 'STOP'}]}
        with patch.dict(os.environ, {'MIX_API_COST_ENABLED': '1'}), patch('costs.configured_credits', return_value=client):
            with self.assertRaises(ValueError):
                with billing_scope('a' * 64, 'job:' + 'b' * 32):
                    Models().json('真实画面')
        client.reject_result.assert_called_once()


if __name__ == '__main__':
    unittest.main()
