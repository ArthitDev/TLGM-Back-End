const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
    const accessToken = req.cookies.accessToken;
    const refreshToken = req.cookies.refreshToken;

    if (!accessToken) {
        return res.status(401).json({ message: 'Authentication required' });
    }

    try {
        const decoded = jwt.verify(accessToken, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (accessError) {
        if (!refreshToken) {
            return res.status(403).json({ message: 'Invalid or expired token' });
        }

        try {
            const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
            
            const newAccessToken = jwt.sign(
                { 
                    userId: decoded.userId,
                    role: decoded.role
                },
                process.env.JWT_SECRET,
                { expiresIn: '15m' }
            );

            res.cookie('accessToken', newAccessToken, {
                httpOnly: true,
                secure: true,
                sameSite: 'none',
                maxAge: 15 * 60 * 1000
            });

            req.user = decoded;
            next();
        } catch (refreshError) {
            return res.status(403).json({ message: 'Invalid or expired refresh token' });
        }
    }
};

module.exports = authenticateToken; 