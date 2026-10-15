"""SyncNet v2 architecture for the published Chung/Zisserman weights.

See NOTICE.md for model/source attribution. Inference only, CPU, no downloads.
"""
import torch.nn as nn


def conv2(cin, cout, kernel, padding=0):
    return [nn.Conv2d(cin, cout, kernel, padding=padding), nn.BatchNorm2d(cout), nn.ReLU()]


def conv3(cin, cout, kernel, stride=1, padding=0):
    return [nn.Conv3d(cin, cout, kernel, stride=stride, padding=padding), nn.BatchNorm3d(cout), nn.ReLU()]


class SyncNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.netcnnaud = nn.Sequential(
            *conv2(1, 64, (3, 3), 1), nn.MaxPool2d(1),
            *conv2(64, 192, (3, 3), 1), nn.MaxPool2d(3, (1, 2)),
            *conv2(192, 384, (3, 3), 1),
            *conv2(384, 256, (3, 3), 1),
            *conv2(256, 256, (3, 3), 1), nn.MaxPool2d(3, 2),
            *conv2(256, 512, (5, 4)),
        )
        self.netcnnlip = nn.Sequential(
            *conv3(3, 96, (5, 7, 7), (1, 2, 2)), nn.MaxPool3d((1, 3, 3), (1, 2, 2)),
            *conv3(96, 256, (1, 5, 5), (1, 2, 2), (0, 1, 1)), nn.MaxPool3d((1, 3, 3), (1, 2, 2), (0, 1, 1)),
            *conv3(256, 256, (1, 3, 3), padding=(0, 1, 1)),
            *conv3(256, 256, (1, 3, 3), padding=(0, 1, 1)),
            *conv3(256, 256, (1, 3, 3), padding=(0, 1, 1)), nn.MaxPool3d((1, 3, 3), (1, 2, 2)),
            *conv3(256, 512, (1, 6, 6)),
        )
        def head():
            return nn.Sequential(nn.Linear(512, 512), nn.BatchNorm1d(512), nn.ReLU(), nn.Linear(512, 1024))
        self.netfcaud, self.netfclip = head(), head()

    def forward_aud(self, x):
        return self.netfcaud(self.netcnnaud(x).flatten(1))

    def forward_lip(self, x):
        return self.netfclip(self.netcnnlip(x).flatten(1))
