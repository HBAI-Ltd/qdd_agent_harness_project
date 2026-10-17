#pragma once
#define F_GETFL 3
#define F_SETFL 4
#define O_NONBLOCK 0x800
int qdd_test_fcntl(int descriptor, int command, ...);
#define fcntl qdd_test_fcntl
